import type { UnifiedCandle } from '../../types.js'

/**
 * Compact wire format for candles: [time, open, high, low, close, volume].
 * Same shape as the Redis chunk storage in history.ts. Avoids repeating
 * symbol/exchange/timeframe strings for every candle in API/WS responses,
 * cutting JSON payload size roughly 2-3x.
 */
export type CompactCandle = [number, number, number, number, number, number]

export function compactCandles(candles: UnifiedCandle[]): CompactCandle[] {
  return candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume])
}
