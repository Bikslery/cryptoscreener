import type { UnifiedCandle } from '../types'

export function isFiniteOHLCV(c: { open: number; high: number; low: number; close: number; volume: number }): boolean {
  return isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) && isFinite(c.volume)
}

export function validateCandle(c: UnifiedCandle): boolean {
  if (!isFiniteOHLCV(c)) return false
  if (c.high < c.low) return false
  if (c.high < c.open || c.high < c.close) return false
  if (c.low > c.open || c.low > c.close) return false
  if (c.volume < 0) return false
  if (!c.time || c.time <= 0) return false
  return true
}

export function normalizeCandle<T extends UnifiedCandle>(c: T): T {
  if (!isFiniteOHLCV(c)) return c
  const all = [c.open, c.high, c.low, c.close]
  const h = Math.max(...all)
  const l = Math.min(...all)
  if (c.high === h && c.low === l) return c
  return { ...c, high: h, low: l }
}

/**
 * Cap for client-side period-jump bridging: beyond this many missing periods
 * (clock skew / bad data) nothing is synthesized and the jump is logged.
 */
export const MAX_FORWARD_FILL_PERIODS = 120

/**
 * Flat bridge bars for a period jump: anchored to the previous close,
 * volume 0, marked final. The caller paints them right before the incoming
 * bar so lightweight-charts never inserts whitespace between the tail and
 * the new bar; a background backfill then swaps them for real rows.
 */
export function forwardFillGap(
  lastBar: UnifiedCandle,
  incomingTime: number,
  tfSec: number,
): UnifiedCandle[] {
  const periods = Math.round((incomingTime - lastBar.time) / tfSec)
  const missing = Math.min(periods - 1, MAX_FORWARD_FILL_PERIODS)
  const fillers: UnifiedCandle[] = []
  for (let i = 1; i <= missing; i++) {
    fillers.push({
      ...lastBar,
      time: lastBar.time + i * tfSec,
      open: lastBar.close,
      high: lastBar.close,
      low: lastBar.close,
      close: lastBar.close,
      volume: 0,
      isFinal: true,
    })
  }
  return fillers
}

/** A synthetic bridge bar produced by forwardFillGap (flat, zero volume). */
export function isFlatFiller(c: UnifiedCandle): boolean {
  return c.volume === 0 && c.open === c.high && c.high === c.low && c.low === c.close
}

/** Total bridge-bar budget for one array pass — a pathological input cannot
 *  balloon into thousands of synthetic rows. */
const CONTIGUIFY_TOTAL_BUDGET = MAX_FORWARD_FILL_PERIODS * 4

/**
 * Normalize ANY candle array into a time-contiguous series: wherever neighbors
 * skip periods, insert flat bridge bars (forwardFillGap semantics). Applied
 * before every setData() so history holes — un-repaired server cache, bulk
 * pushes, reconnect tails — never render as lightweight-charts whitespace.
 * Returns the input by reference when already contiguous.
 */
export function contiguify(candles: UnifiedCandle[], tfSec: number): UnifiedCandle[] {
  if (!Number.isFinite(tfSec) || tfSec <= 0 || candles.length < 2) return candles
  let output: UnifiedCandle[] | null = null
  let filledTotal = 0
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]
    const cur = candles[i]
    const gapPeriods = Math.round((cur.time - prev.time) / tfSec)
    const missing = gapPeriods > 1 ? Math.min(gapPeriods - 1, MAX_FORWARD_FILL_PERIODS) : 0
    if (missing > 0 && filledTotal < CONTIGUIFY_TOTAL_BUDGET) {
      if (!output) output = candles.slice(0, i)
      for (let k = 1; k <= missing && filledTotal < CONTIGUIFY_TOTAL_BUDGET; k++) {
        output.push({
          ...prev,
          time: prev.time + k * tfSec,
          open: prev.close,
          high: prev.close,
          low: prev.close,
          close: prev.close,
          volume: 0,
          isFinal: true,
        })
        filledTotal++
      }
    }
    if (output) output.push(cur)
  }
  return output || candles
}
