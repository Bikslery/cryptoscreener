import type { UnifiedCandle, Exchange } from '../types'

/**
 * Compact wire format for candles: [time, open, high, low, close, volume].
 * Avoids repeating symbol/exchange/timeframe strings for every candle,
 * cutting JSON payload size roughly 2-3x.
 */
export type CompactCandle = [number, number, number, number, number, number]

export function expandCompactCandles(
  tuples: CompactCandle[],
  symbol: string,
  exchange: Exchange,
  timeframe: string,
): UnifiedCandle[] {
  return tuples.map(([time, open, high, low, close, volume]) => ({
    symbol, exchange, timeframe, time, open, high, low, close, volume,
  }))
}
