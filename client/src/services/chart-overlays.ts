import type { UnifiedCandle } from '../types'

/**
 * Chart overlays data — scalpboard.io parity (peaks / cascades / density).
 *
 * RENDERING parity is exact (ported verbatim from scalpboard's bundle);
 * the DATA is computed locally from the candles we already hold, because
 * scalpboard's peaks/density live on their closed backend. The formulas
 * below reproduce the observable behavior:
 *
 *  - peaks: every local extremum (high >= both neighbours / low <= both
 *    neighbours) is a peak {e: price, t: epoch, c: volume}. Plateaus form
 *    dense runs — exactly what cascades need to cluster into ladders.
 *  - cascades: verbatim port of scalpboard's calcCascades(): consecutive
 *    peaks on the same side chained while the directional distance to the
 *    previous member stays <= maxDistance%; a chain with >= minPeaks
 *    members becomes a cascade. Defaults match scalpboard:
 *    minPeaks: 2, maxDistance: 0.4 (%).
 *  - density: volume-by-price profile built from candle high-low ranges,
 *    bucketed to a tick; 'a' = resistance rows (red, from bearish candles),
 *    'b' = support rows (green, from bullish candles).
 */

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

export interface DensityRow {
  price: number
  size: number
  /** epoch seconds of the last touch (line goes from here to the right edge) */
  time: number
  /** 'a' = resistance (red, baseline bottom), 'b' = support (green, baseline top) */
  direction: 'a' | 'b'
}

export interface OverlaysData {
  cascades: OverlayCascades
  densities: DensityRow[]
}

/** local extrema: every candle whose high >= both neighbours (and low <= both) */
export function detectPeaks(candles: UnifiedCandle[]): { h: OverlayPeak[]; l: OverlayPeak[] } {
  const h: OverlayPeak[] = []
  const l: OverlayPeak[] = []
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    const next = candles[i + 1]
    if (c.high >= prev.high && c.high >= next.high) {
      h.push({ e: c.high, t: c.time, c: c.volume })
    }
    if (c.low <= prev.low && c.low <= next.low) {
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

/** cascades for both sides of the price ladder */
export function computeCascades(
  candles: UnifiedCandle[],
  minPeaks: number,
  maxDistance: number,
): OverlayCascades {
  const peaks = detectPeaks(candles)
  return {
    h: calcCascades(peaks.h, 'h', minPeaks, maxDistance),
    l: calcCascades(peaks.l, 'l', minPeaks, maxDistance),
  }
}

const MAX_BUCKETS = 500

/**
 * Volume-by-price profile over the candle history. Each candle spreads its
 * volume uniformly across the buckets between its low and high. Bucket size
 * follows the price tick but is widened when the range would explode the
 * bucket count. Direction: bearish candles feed 'a' (resistance, red),
 * bullish candles feed 'b' (support, green). Rows below the visibility
 * threshold (a fraction of the strongest level) are dropped.
 */
export function computeDensities(
  candles: UnifiedCandle[],
  pricePrecision: number,
  thresholdPct = 0.015,
): DensityRow[] {
  if (candles.length === 0) return []
  let minP = Infinity
  let maxP = -Infinity
  for (const c of candles) {
    if (c.low < minP) minP = c.low
    if (c.high > maxP) maxP = c.high
  }
  if (!isFinite(minP) || !isFinite(maxP) || maxP <= minP) return []

  const tick = Math.pow(10, -pricePrecision)
  const idealBuckets = Math.min(MAX_BUCKETS, Math.ceil((maxP - minP) / tick))
  const bucketSize = Math.max(tick, (maxP - minP) / idealBuckets)

  const aSize = new Map<number, number>()
  const aTime = new Map<number, number>()
  const bSize = new Map<number, number>()
  const bTime = new Map<number, number>()

  const bucketOf = (price: number): number => Math.floor((price - minP) / bucketSize)

  for (const c of candles) {
    const from = Math.max(0, bucketOf(c.low))
    const to = Math.min(idealBuckets - 1, bucketOf(c.high))
    const span = to - from + 1
    if (span <= 0) continue
    const share = c.volume / span
    const target = c.close >= c.open ? 'b' : 'a'
    const sizeMap = target === 'a' ? aSize : bSize
    const timeMap = target === 'a' ? aTime : bTime
    for (let b = from; b <= to; b++) {
      sizeMap.set(b, (sizeMap.get(b) ?? 0) + share)
      timeMap.set(b, c.time)
    }
  }

  const rows: DensityRow[] = []
  const consider = (sizeMap: Map<number, number>, timeMap: Map<number, number>, direction: 'a' | 'b') => {
    let maxSize = 0
    for (const [, s] of sizeMap) if (s > maxSize) maxSize = s
    if (maxSize <= 0) return
    const cutoff = maxSize * thresholdPct
    for (const [b, s] of sizeMap) {
      if (s < cutoff) continue
      rows.push({
        price: minP + (b + 0.5) * bucketSize,
        size: s,
        time: timeMap.get(b) ?? 0,
        direction,
      })
    }
  }
  consider(aSize, aTime, 'a')
  consider(bSize, bTime, 'b')

  return rows.sort((x, y) => y.size - x.size).slice(0, 120)
}

/** full overlay payload for one chart */
export function computeOverlays(
  candles: UnifiedCandle[],
  pricePrecision: number,
  minPeaks: number,
  maxDistance: number,
): OverlaysData {
  return {
    cascades: computeCascades(candles, minPeaks, maxDistance),
    densities: computeDensities(candles, pricePrecision),
  }
}