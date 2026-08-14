import type { UnifiedCandle, UnifiedTicker, ImpulseAlertCondition, ImpulseExchangeCondition } from '../../types.js'

/**
 * Pick the ticker for a symbol following the condition's exchange order:
 * the first exchange in the array that has a ticker for the symbol AND whose
 * 24h quote volume meets the per-exchange minimum wins (priority = order).
 */
export function pickExchangeTicker(
  bySymbol: Map<string, Map<string, UnifiedTicker>>,
  symbol: string,
  exchanges: ImpulseExchangeCondition[],
): UnifiedTicker | null {
  for (const ex of exchanges) {
    const t = bySymbol.get(symbol)?.get(ex.exchange)
    if (t && t.quoteVolume24h >= ex.minVolume24h) return t
  }
  return null
}

/** Index of the last CLOSED candle (forming candles are not eligible), -1 if none. */
export function lastFinalCandleIndex(candles: UnifiedCandle[]): number {
  let idx = candles.length - 1
  while (idx >= 0 && !candles[idx].isFinal) idx--
  return idx
}

/**
 * All impulse conditions on one closed candle: range move >= percent, the
 * configured direction (close vs open), and — when enabled — volume spike vs
 * the 30-candle baseline ending right before the candle.
 */
export function matchesImpulseCandle(
  cond: ImpulseAlertCondition,
  candle: UnifiedCandle,
  baseline: UnifiedCandle[],
): boolean {
  const movePct = candle.low > 0 ? ((candle.high - candle.low) / candle.low) * 100 : 0
  if (movePct < cond.percent) return false
  if (cond.direction === 'up' && candle.close < candle.open) return false
  if (cond.direction === 'down' && candle.close > candle.open) return false
  if (cond.volumeSpike > 0) {
    if (baseline.length < 30) return false
    const avg = baseline.reduce((s, c) => s + c.volume, 0) / baseline.length
    if (avg <= 0 || candle.volume / avg < cond.volumeSpike) return false
  }
  return true
}
