import type { UnifiedCandle, UnifiedTicker } from '../../types.js'

export const BUCKET_MS = 300_000 // 5m
export const MAX_BUCKETS = 30
export const MIN_BUCKETS = 5
export const CORR_WINDOW = 60 // 60 × 5m = 5h

/**
 * Pearson correlation coefficient over the first `n = min(xs, ys)` elements.
 * Returns null when there are < 2 pairs or either series has zero variance.
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
    sxy += xs[i] * ys[i]
    sxx += xs[i] * xs[i]
    syy += ys[i] * ys[i]
  }
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy))
  if (!isFinite(denom) || denom === 0) return null
  return (n * sxy - sx * sy) / denom
}

/**
 * Volume spike: the forming (last) 5m candle volume divided by the average
 * volume of the 30 completed candles before it. Null when there is not
 * enough data or the baseline average is zero.
 */
export function computeVolumeSpike(candles: UnifiedCandle[]): number | null {
  if (candles.length < MAX_BUCKETS + 1) return null
  const window = candles.slice(-(MAX_BUCKETS + 1))
  const last = window[window.length - 1]
  const baseline = window.slice(0, MAX_BUCKETS)
  const avg = baseline.reduce((s, c) => s + c.volume, 0) / baseline.length
  if (!isFinite(avg) || avg <= 0) return null
  const spike = last.volume / avg
  return isFinite(spike) ? spike : null
}

interface BucketState {
  currentKey: number
  currentCount: number
  completed: number[]
}

/**
 * Per-symbol 5m trade-count buckets fed by the Binance aggTrade lanes
 * (spot + futures streams sum into one series per symbol). The spike is the
 * last COMPLETED bucket vs the average of the completed ones before it —
 * a forming bucket always under-counts, so it never participates. Values
 * appear after MIN_BUCKETS completed buckets (~25 min) and stabilize as the
 * window grows toward MAX_BUCKETS (2.5 h).
 */
export class TradeBucketTracker {
  private buckets = new Map<string, BucketState>()

  recordTrade(symbol: string, timeMs: number): { spike: number } | null {
    const key = Math.floor(timeMs / BUCKET_MS) * BUCKET_MS
    let state = this.buckets.get(symbol)
    if (!state) {
      state = { currentKey: key, currentCount: 0, completed: [] }
      this.buckets.set(symbol, state)
    }
    if (key !== state.currentKey) {
      state.completed.push(state.currentCount)
      if (state.completed.length > MAX_BUCKETS) state.completed.shift()
      state.currentKey = key
      state.currentCount = 1 // this trade belongs to the new bucket
      const spike = this.getSpike(symbol)
      if (spike !== null) return { spike }
      return null
    }
    state.currentCount++
    return null
  }

  getSpike(symbol: string): number | null {
    const state = this.buckets.get(symbol)
    if (!state || state.completed.length < MIN_BUCKETS) return null
    const last = state.completed[state.completed.length - 1]
    const rest = state.completed.slice(0, -1)
    const avg = rest.reduce((s, v) => s + v, 0) / rest.length
    if (avg <= 0) return null
    const spike = last / avg
    return isFinite(spike) ? spike : null
  }

  entries(): Array<[string, number | null]> {
    return Array.from(this.buckets.keys()).map(symbol => [symbol, this.getSpike(symbol)])
  }

  get size(): number {
    return this.buckets.size
  }
}

/**
 * Write indicator values straight into every exchange entry of a symbol in
 * the ticker map so the next delta broadcast picks the change up immediately
 * (the metricsMap→onTicker path would stall quiet symbols until their next
 * trade). Optional `exchanges` set restricts the write to specific exchange
 * entries (tradesSpike must never leak into Bybit/OKX tickers).
 */
export function applyIndicator(
  tickerMap: Map<string, UnifiedTicker>,
  symbol: string,
  patch: Partial<UnifiedTicker>,
  exchanges?: Set<string>,
): void {
  for (const [key, t] of tickerMap) {
    if (!key.startsWith(`${symbol}:`)) continue
    if (exchanges && !exchanges.has(t.exchange)) continue
    Object.assign(t, patch)
  }
}
