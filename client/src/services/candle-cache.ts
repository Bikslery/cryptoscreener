import type { UnifiedCandle } from '../types.js'

// In-memory candle cache — persists for the browser session.
// Key format: "BTCUSDT:5m" → UnifiedCandle[]

const cache = new Map<string, UnifiedCandle[]>()
const MAX_CANDLES_PER_KEY = 80000

export function getCandles(symbol: string, tf: string): UnifiedCandle[] | undefined {
  return cache.get(`${symbol}:${tf}`)
}

export function setCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const key = `${symbol}:${tf}`
  if (candles.length > MAX_CANDLES_PER_KEY) {
    cache.set(key, candles.slice(-MAX_CANDLES_PER_KEY))
  } else {
    cache.set(key, candles)
  }
}

/** Merge historical candles with existing data. New data takes priority on time overlap. */
export function prependCandles(symbol: string, tf: string, older: UnifiedCandle[]): void {
  const key = `${symbol}:${tf}`
  const existing = cache.get(key)
  if (!existing || existing.length === 0) {
    setCandles(symbol, tf, older)
    return
  }
  if (older.length === 0) return

  const timeMap = new Map<number, UnifiedCandle>()
  for (const c of older) timeMap.set(c.time, c)
  for (const c of existing) timeMap.set(c.time, c) // existing overwrites on collision

  const merged = Array.from(timeMap.values()).sort((a, b) => a.time - b.time)
  setCandles(symbol, tf, merged.length > MAX_CANDLES_PER_KEY ? merged.slice(-MAX_CANDLES_PER_KEY) : merged)
}

/** Update or append a single candle from WS */
export function updateCandle(candle: UnifiedCandle): void {
  const key = `${candle.symbol}:${candle.timeframe}`
  const arr = cache.get(key)
  if (!arr) return

  const last = arr[arr.length - 1]
  if (last && last.time === candle.time) {
    // In-place mutation — no array copy
    arr[arr.length - 1] = candle
  } else if (!last || candle.time > last.time) {
    arr.push(candle)
    if (arr.length > MAX_CANDLES_PER_KEY) arr.shift()
  }
}

/** Store bulk data from /candles-bulk response */
export function storeBulk(data: Record<string, UnifiedCandle[]>, tf: string): void {
  for (const [symbol, candles] of Object.entries(data)) {
    if (candles.length > 0) setCandles(symbol, tf, candles)
  }
}

/** Get earliest candle time for a symbol:tf */
export function getEarliest(symbol: string, tf: string): number | undefined {
  const arr = cache.get(`${symbol}:${tf}`)
  return arr?.[0]?.time
}

/** Clear all data except for one symbol (frees memory when expanding a chart) */
export function clearAllExceptSymbol(keepSymbol: string): void {
  for (const key of Array.from(cache.keys())) {
    if (!key.startsWith(`${keepSymbol}:`)) cache.delete(key)
  }
}

/** Clear all cache */
export function clearAll(): void {
  cache.clear()
}

/** Check if we have data for a symbol:tf */
export function hasCandles(symbol: string, tf: string): boolean {
  const arr = cache.get(`${symbol}:${tf}`)
  return !!arr && arr.length > 0
}
