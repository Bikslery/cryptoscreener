import type { UnifiedCandle, UnifiedTicker, ImpulseAlertCondition, ImpulseExchangeCondition } from '../../types.js'

export const DEFAULT_IMPULSE_EXCHANGES: ImpulseExchangeCondition[] = [
  { exchange: 'binance-futures', minVolume24h: 0 },
  { exchange: 'binance-spot', minVolume24h: 0 },
  { exchange: 'bybit-futures', minVolume24h: 0 },
]

/** Legacy pre-upgrade rows {percent, within} get the new defaults in memory. */
export function normalizeImpulseCondition(cond: ImpulseAlertCondition): ImpulseAlertCondition {
  return {
    percent: typeof cond.percent === 'number' ? cond.percent : 1,
    timeframe: cond.timeframe === '1m' || cond.timeframe === '5m' ? cond.timeframe : '5m',
    direction: cond.direction === 'up' || cond.direction === 'down' || cond.direction === 'both' ? cond.direction : 'both',
    volumeSpike: typeof cond.volumeSpike === 'number' && cond.volumeSpike > 0 ? cond.volumeSpike : 0,
    exchanges: Array.isArray(cond.exchanges) && cond.exchanges.length > 0 ? cond.exchanges : DEFAULT_IMPULSE_EXCHANGES,
    // Telegram stays opt-in — legacy rows never had the flag.
    telegram: cond.telegram === true,
    lastFiredCandleTime: cond.lastFiredCandleTime,
    mutedUntil: cond.mutedUntil,
  }
}

/** Scalpboard parity: after an impulse fires, the alert stays silent for 5 minutes. */
export const IMPULSE_MUTE_MS = 300_000

export function isImpulseMuted(cond: ImpulseAlertCondition, now = Date.now()): boolean {
  return typeof cond.mutedUntil === 'number' && cond.mutedUntil > now
}

/** Record a firing: per-candle dedupe + the 5-minute mute window. */
export function markImpulseFired(cond: ImpulseAlertCondition, candleTime: number, now = Date.now()): ImpulseAlertCondition {
  return {
    ...cond,
    lastFiredCandleTime: candleTime,
    mutedUntil: now + IMPULSE_MUTE_MS,
  }
}

/** Candle data is stale when the last row is older than ~1.5 timeframe periods. */
export function isCandleStale(lastCandleTime: number, timeframe: string, now = Date.now()): boolean {
  const tfSec = timeframe === '1m' ? 60 : timeframe === '5m' ? 300 : 0
  if (tfSec === 0) return false
  return now - lastCandleTime > tfSec * 1.5
}

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

/**
 * Index of the last candle. Forming candles are eligible — the alert fires
 * as soon as the moving candle meets the conditions, not when it closes.
 * The WS kline lane (watched symbols) and the REST warm loop (unwatched)
 * both refresh the last cache row continuously, and lastFiredCandleTime
 * prevents refiring on the same candle.
 */
export function lastCandleIndex(candles: UnifiedCandle[]): number {
  return candles.length - 1
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
