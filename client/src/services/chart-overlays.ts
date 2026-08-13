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
 * Verbatim port of scalpboard's calcCascades():
 * walk the peaks and chain every consecutive member whose directional
 * distance to the previous anchor stays within maxDistance%; a chain of
 * >= minPeaks members is a cascade. The walk for the NEXT cascade resumes
 * right after the member that broke the previous chain.
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
      if (dist <= maxDistance / 100) {
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
    let chains = calcCascades(peaks[side], side, c.minPeaks, c.maxDistance)
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