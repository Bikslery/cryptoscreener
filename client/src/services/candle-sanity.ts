import type { UnifiedCandle } from '../types'
import { recordDiag } from './candle-diag'

/**
 * Phantom-candle guard ("a huge fake candle that disappears on refresh").
 *
 * Somewhere between the wire and the render one garbage value can land inside
 * a single candle (shifted digit, foreign price point leaked into a mid/trade
 * frame, a spoiled cache row). LWC happily paints it — a full body+wick that
 * is 10-30x larger than its neighbours — and it vanishes on a refresh because
 * the server never had it.
 *
 * This module provides:
 *  - `classifyCandle`  — flags a candle whose range/price is absurd relative
 *    to its local context (tuned to fire well ABOVE ordinary flash wicks);
 *  - `sanitizeCandle`  — rebuilds such a candle INSIDE the neighbours' band
 *    (never drops it, so no hole appears), logs every decision.
 *
 * Diagnostics only + a last-resort value clamp. Real data is never corrupted:
 * a legit candle is returned unchanged; the authoritative kline / a refetch
 * overwrite the clamped placeholder later.
 */

export const CONTEXT_WINDOW = 12
/** range trigger: candle range > N x local median range (user observed 10-30x). */
export const RANGE_FACTOR_TRIGGER = 8
/** price trigger: candle price outside N x the neighbours' median close. */
export const PRICE_FACTOR_TRIGGER = 8

export type SanityKind = 'nonfinite' | 'range' | 'price' | null

export interface SanityResult {
  candle: UnifiedCandle
  isOutlier: boolean
  kind: SanityKind
  rangeRatio: number
  original?: { open: number; high: number; low: number; close: number; volume: number }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function isFiniteC(c: UnifiedCandle, checkVolume = false): boolean {
  return (
    isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)
    && c.high >= c.low
    && (!checkVolume || isFinite(c.volume))
  )
}

/** Up to CONTEXT_WINDOW candles strictly before `endIndex` (or the array end). */
export function contextWindow(arr: UnifiedCandle[], endIndex: number): UnifiedCandle[] {
  const start = Math.max(0, (endIndex < 0 ? arr.length : endIndex) - CONTEXT_WINDOW)
  return arr.slice(start, endIndex < 0 ? arr.length : endIndex)
}

function classify(c: UnifiedCandle, ctx: UnifiedCandle[]): Omit<SanityResult, 'candle'> {
  if (!isFiniteC(c)) return { isOutlier: true, kind: 'nonfinite', rangeRatio: Infinity }
  const clean = ctx.filter(x => isFiniteC(x) && x.close > 0)
  if (clean.length < Math.min(3, CONTEXT_WINDOW / 2)) {
    return { isOutlier: false, kind: null, rangeRatio: 0 }
  }
  const ranges = clean.map(x => x.high - x.low)
  const medRange = median(ranges)
  const medClose = median(clean.map(x => x.close))
  const safeMed = Math.max(medRange, Math.abs(medClose) * 1e-6, 1e-12)
  const rr = (c.high - c.low) / safeMed

  const priceOut = c.high > PRICE_FACTOR_TRIGGER * medClose || c.low < medClose / PRICE_FACTOR_TRIGGER
  const rangeOut = rr > RANGE_FACTOR_TRIGGER

  // A phantom is BOTH wildly wide AND off the local price band. A sharp real
  // move is wide but stays near the neighbours' price → left untouched.
  if (rangeOut && priceOut) return { isOutlier: true, kind: 'range', rangeRatio: rr }
  return { isOutlier: false, kind: null, rangeRatio: rr }
}

export function sanitizeCandle(c: UnifiedCandle, ctx: UnifiedCandle[], via = 'unknown'): UnifiedCandle {
  const det = classify(c, ctx)
  if (!det.isOutlier) return c

  const original = { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
  let out: UnifiedCandle

  if (det.kind === 'nonfinite') {
    const med = median(ctx.filter(x => isFiniteC(x) && x.close > 0).map(x => x.close))
    const prevClose = med > 0 ? med : c.close
    out = {
      ...c,
      open: prevClose, high: prevClose, low: prevClose, close: prevClose,
      volume: 0,
    }
  } else {
    const clean = ctx.filter(x => isFiniteC(x))
    const bandLow = clean.reduce((a, x) => Math.min(a, x.low), clean[0]?.low ?? c.low)
    const bandHigh = clean.reduce((a, x) => Math.max(a, x.high), clean[0]?.high ?? c.high)
    const medClose = median(clean.map(x => x.close)) || bandHigh

    // Shifted body (open/close far outside the band) — pull into the median.
    let open = c.open
    let close = c.close
    if (close > PRICE_FACTOR_TRIGGER * medClose || PRICE_FACTOR_TRIGGER * close < medClose) close = medClose
    if (open > PRICE_FACTOR_TRIGGER * medClose || PRICE_FACTOR_TRIGGER * open < medClose) open = medClose
    // Collapse the giant wick into the band without breaking O<=... continuity.
    const high = Math.max(bandHigh, open, close)
    const low = Math.min(bandLow, open, close)
    out = { ...c, open, close, high, low }
  }

  recordDiag('anomalous_candle', {
    symbol: c.symbol,
    exchange: c.exchange,
    tf: c.timeframe,
    from: c.time,
    detail: JSON.stringify({
      via,
      source: c.source,
      kind: det.kind,
      rangeRatio: Number.isFinite(det.rangeRatio) ? Math.round(det.rangeRatio) : det.rangeRatio,
      original,
      sanitized: { open: out.open, high: out.high, low: out.low, close: out.close },
    }),
  })

  return out
}

/** Sanitize a full series (history load / repaint input). Clean context = the
 *  already-sanitized predecessors, so one garbage row can't skew the band. */
export function sanitizeSeries(candles: UnifiedCandle[], via = 'history'): UnifiedCandle[] {
  const out: UnifiedCandle[] = []
  for (const c of candles) {
    out.push(sanitizeCandle(c, out.slice(-CONTEXT_WINDOW), via))
  }
  return out
}

/** Report (no mutation) every candle flagged as an outlier against its own
 *  predecessors — used by the self-heal sweep to notice a persisted phantom. */
export function findOutlierCandles(candles: UnifiedCandle[]): UnifiedCandle[] {
  const out: UnifiedCandle[] = []
  for (let i = 0; i < candles.length; i++) {
    if (classify(candles[i], contextWindow(candles, i)).isOutlier) out.push(candles[i])
  }
  return out
}
