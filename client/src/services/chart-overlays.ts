import type { CascadesConfig, UnifiedCandle } from '../types'

/**
 * Chart overlays data — scalpboard.io parity (peaks / cascades).
 *
 * RENDERING parity is exact (ported verbatim from scalpboard's bundle);
 * the DATA is computed locally from the candles we already hold, because
 * scalpboard's peaks live on their closed backend. The formulas below
 * reproduce the observable behavior:
 *
 *  - peaks: every local extremum (high >= both neighbours / low <= both
 *    neighbours) is a peak {e: price, t: epoch, c: volume}. Plateaus form
 *    dense runs — exactly what cascades need to cluster into ladders.
 *    An optional noise filter (prominence window / min prominence / min
 *    volume / lookback) keeps candle-derived peaks meaningful — without it
 *    every candle wiggle becomes a cascade level and the chart drowns.
 *  - cascades: verbatim port of scalpboard's calcCascades(): consecutive
 *    peaks on the same side chained while the directional distance to the
 *    previous member stays <= maxDistance%; a chain with >= minPeaks
 *    members becomes a cascade. Defaults match scalpboard:
 *    minPeaks: 2, maxDistance: 0.4 (%).
 *  - crossing: scalpboard's server deletes a peak once price trades through
 *    its level and cascades are recomputed from the survivors, so a cascade
 *    disappears when price crosses it. Candle data has no such lifecycle, so
 *    filterCrossedPeaks() drops every peak a LATER candle has traded through
 *    (high above an h-level, low under an l-level) before chaining — crossed
 *    ladders vanish, live ones stay.
 *  - touches: filterByTouches() hides cascades that price did not approach
 *    often enough — a cascade is drawn only after minTouches candles came
 *    within touchDistancePct% of one of its levels (0 = at least one touch).
 *    Only genuine re-tests count: the members' own formation candles (±
 *    prominenceWindow bars) never count as touches.
 */

export const DEFAULT_CASCADES_CONFIG: CascadesConfig = {
  showCascades: true,
  minPeaks: 2,
  maxDistance: 0.4,
  prominenceWindow: 3,
  minProminencePct: 0.15,
  minVolumePct: 5,
  lookback: 0,
  maxCascades: 0,
  maxChainLen: 0,
  minTouches: 0,
  touchDistancePct: 0.15,
  showLabels: true,
  lineWidth: 1,
  opacity: 100,
}

export type CascadesConfigPatch = Partial<CascadesConfig>

export function resolveCascadesConfig(patch?: CascadesConfigPatch): CascadesConfig {
  return { ...DEFAULT_CASCADES_CONFIG, ...patch }
}

export interface OverlayPeak {
  /** price of the extremum */
  e: number
  /** epoch seconds of the candle */
  t: number
  /** volume of the extremum candle */
  c: number
  /** distance % to the previous cascade member (set by calcCascades, parity) */
  d?: number
}

export interface OverlayCascades {
  h: OverlayPeak[][]
  l: OverlayPeak[][]
}

export interface OverlayRenderOptions {
  showLabels: boolean
  lineWidth: number
  opacity: number
}

export interface OverlaysData {
  cascades: OverlayCascades
  render: OverlayRenderOptions
}

export interface PeakDetectOptions {
  prominenceWindow?: number
  minProminencePct?: number
  minVolumePct?: number
  lookback?: number
}

/**
 * Local extrema over the candle history. Every candle whose high >= the
 * highs of its prominence-window neighbours (and low <= the lows) is a peak;
 * window 1 with zero thresholds reproduces scalpboard's raw peak set.
 * Optional filters (all relative, configurable from the cabinet):
 *  - prominenceWindow: compare against ±N candles instead of direct neighbours
 *  - minProminencePct: the extremum must stand out from its window neighbours
 *  - minVolumePct: the extremum candle must carry volume (vs window max)
 *  - lookback: only consider the last N candles (0 = whole history)
 */
export function detectPeaks(candles: UnifiedCandle[], opts?: PeakDetectOptions): { h: OverlayPeak[]; l: OverlayPeak[] } {
  const windowBars = opts?.prominenceWindow ?? 1
  const minProminence = (opts?.minProminencePct ?? 0) / 100
  const minVolumeFrac = (opts?.minVolumePct ?? 0) / 100
  const lookback = opts?.lookback ?? 0
  const from = lookback > 0 ? Math.max(1, candles.length - lookback) : 1

  const h: OverlayPeak[] = []
  const l: OverlayPeak[] = []
  for (let i = from; i < candles.length - 1; i++) {
    const c = candles[i]
    const lo = Math.max(0, i - windowBars)
    const hi = Math.min(candles.length - 1, i + windowBars)
    let maxHi = -Infinity
    let minLo = Infinity
    let maxVol = 0
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue
      const p = candles[j]
      if (p.high > maxHi) maxHi = p.high
      if (p.low < minLo) minLo = p.low
      if (p.volume > maxVol) maxVol = p.volume
    }
    if (minVolumeFrac > 0 && maxVol > 0 && c.volume / maxVol < minVolumeFrac) continue
    if (c.high >= maxHi && (c.high - maxHi) / c.close >= minProminence) {
      h.push({ e: c.high, t: c.time, c: c.volume })
    }
    if (c.low <= minLo && (minLo - c.low) / c.close >= minProminence) {
      l.push({ e: c.low, t: c.time, c: c.volume })
    }
  }
  return { h, l }
}

/**
 * Walk the peaks and chain every consecutive member whose gap to the
 * previous anchor stays within maxDistance%; a chain of >= minPeaks members
 * is a cascade. The walk for the NEXT cascade resumes right after the member
 * that broke the previous chain.
 *
 * Based on scalpboard's calcCascades() with one deliberate deviation: the
 * gap is measured in ABSOLUTE terms (|dist| <= maxDistance). Scalpboard
 * chains any step in the "direction of travel" (descending h-peaks,
 * ascending l-peaks) because that distance is negative and always passes —
 * fine for their live order-book peaks, but candle-derived peaks would then
 * chain arbitrarily far apart (e.g. two support levels 6% away become one
 * "cascade" despite maxDistance 0.25%). Absolute distance keeps a cascade a
 * tight cluster of levels.
 */
export function calcCascades(
  peaks: OverlayPeak[],
  side: 'h' | 'l',
  minPeaks: number,
  maxDistance: number,
): OverlayPeak[][] {
  const cascades: OverlayPeak[][] = []
  for (let r = 0; r < peaks.length; r++) {
    const chain: OverlayPeak[] = [peaks[r]]
    let anchor = peaks[r].e
    let d = r + 1
    for (; d < peaks.length; d++) {
      const p = peaks[d].e
      const dist = side === 'h' ? (p - anchor) / anchor : (anchor - p) / anchor
      if (Math.abs(dist) <= maxDistance / 100) {
        chain.push({ ...peaks[d], d: dist * 100 })
        anchor = p
      } else {
        r = d - 1
        break
      }
    }
    if (chain.length >= minPeaks) cascades.push(chain)
    if (d == peaks.length) break
  }
  return cascades
}

/**
 * Drop peaks whose level a later candle has traded through (scalpboard parity:
 * the server deletes a peak once price crosses it). An 'h' peak is dead when
 * some LATER candle's high exceeds it, an 'l' peak when a later candle's low
 * goes under it — any candle crossing the level consumes it, wicks included.
 * Survivors keep their order, so chains recompute from the still-valid levels
 * and a cascade disappears once price has crossed it.
 */
export function filterCrossedPeaks(
  candles: UnifiedCandle[],
  peaks: OverlayPeak[],
  side: 'h' | 'l',
): OverlayPeak[] {
  const n = candles.length
  if (peaks.length === 0 || n < 2) return peaks
  // suffix extremes: the highest high / lowest low reached AFTER each candle
  const suffHigh = new Array<number>(n)
  const suffLow = new Array<number>(n)
  suffHigh[n - 1] = candles[n - 1].high
  suffLow[n - 1] = candles[n - 1].low
  for (let i = n - 2; i >= 0; i--) {
    const c = candles[i]
    suffHigh[i] = Math.max(c.high, suffHigh[i + 1])
    suffLow[i] = Math.min(c.low, suffLow[i + 1])
  }
  const crossed = (t: number, e: number): boolean => {
    // locate the peak's candle (candles are chronological, unique times)
    let lo = 0
    let hi = n - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (candles[mid].time < t) lo = mid + 1
      else hi = mid - 1
    }
    if (lo >= n - 1) return false // peak sits on the last candle — nothing after it
    return side === 'h' ? suffHigh[lo + 1] > e : suffLow[lo + 1] < e
  }
  const live: OverlayPeak[] = []
  for (const p of peaks) {
    if (!crossed(p.t, p.e)) live.push(p)
  }
  return live
}

/**
 * Hide cascades that price did not approach often enough: a cascade is drawn
 * only after at least `minTouches` candles came within `touchDistancePct`% of
 * one of its levels (0 means at least one touch). A touch is the candle's
 * extreme on the valid side of the level — an 'h' level is touched by candles
 * whose high comes within the band below it, an 'l' level by candles whose
 * low comes within the band above it.
 *
 * Only genuine RE-tests count: the cascade's own member candles AND their
 * prominence-window neighborhood (the candles that formed the peak) never
 * count — otherwise every ladder passes on its own formation and the filter
 * is toothless.
 */
export function filterByTouches(
  candles: UnifiedCandle[],
  chains: OverlayPeak[][],
  side: 'h' | 'l',
  minTouches: number,
  touchDistancePct: number,
  prominenceWindow: number,
): OverlayPeak[][] {
  if (chains.length === 0) return chains
  const need = Math.max(1, Math.floor(minTouches))
  const distFrac = Math.max(0, touchDistancePct) / 100
  const n = candles.length
  const idxOf = (t: number): number => {
    let lo = 0
    let hi = n - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (candles[mid].time < t) lo = mid + 1
      else hi = mid - 1
    }
    return lo < n && candles[lo].time === t ? lo : -1
  }
  return chains.filter(chain => {
    // formation neighborhood: every member candle ± prominenceWindow bars
    const excluded = new Set<number>()
    for (const p of chain) {
      const i = idxOf(p.t)
      if (i < 0) continue
      for (let k = Math.max(0, i - prominenceWindow); k <= Math.min(n - 1, i + prominenceWindow); k++) {
        excluded.add(candles[k].time)
      }
    }
    let touches = 0
    for (const c of candles) {
      if (excluded.has(c.time)) continue
      const near = chain.some(p => {
        if (side === 'h') {
          // high approaches the level from below without crossing it
          return c.high <= p.e && (p.e - c.high) / p.e <= distFrac
        }
        return c.low >= p.e && (c.low - p.e) / p.e <= distFrac
      })
      if (near && ++touches >= need) return true
    }
    return false
  })
}

/** cascades for both sides of the price ladder, config-driven */
export function computeCascades(
  candles: UnifiedCandle[],
  config?: CascadesConfigPatch,
): OverlayCascades {
  const c = resolveCascadesConfig(config)
  if (!c.showCascades) return { h: [], l: [] }
  const peaks = detectPeaks(candles, {
    prominenceWindow: c.prominenceWindow,
    minProminencePct: c.minProminencePct,
    minVolumePct: c.minVolumePct,
    lookback: c.lookback,
  })
  const cap = (side: 'h' | 'l'): OverlayPeak[][] => {
    // scalpboard: crossed levels are deleted server-side before chaining
    const live = filterCrossedPeaks(candles, peaks[side], side)
    let chains = calcCascades(live, side, c.minPeaks, c.maxDistance)
    chains = filterByTouches(candles, chains, side, c.minTouches, c.touchDistancePct, c.prominenceWindow)
    if (c.maxChainLen > 0) chains = chains.map(ch => ch.slice(0, c.maxChainLen))
    if (c.maxCascades > 0) chains = chains.slice(0, c.maxCascades)
    return chains
  }
  return { h: cap('h'), l: cap('l') }
}

/** full overlay payload for one chart */
export function computeOverlays(
  candles: UnifiedCandle[],
  config?: CascadesConfigPatch,
): OverlaysData {
  const c = resolveCascadesConfig(config)
  return {
    cascades: computeCascades(candles, c),
    render: {
      showLabels: c.showLabels,
      lineWidth: c.lineWidth,
      opacity: c.opacity,
    },
  }
}