import type { UnifiedCandle } from '../types'

const MAX_CANDLES_PER_KEY = 80000

const cache = new Map<string, UnifiedCandle[]>()

function key(symbol: string, tf: string): string {
  return `${symbol}:${tf}`
}

export function getCandles(symbol: string, tf: string): UnifiedCandle[] | undefined {
  return cache.get(key(symbol, tf))
}

export function setCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const k = key(symbol, tf)
  cache.set(k, candles.length > MAX_CANDLES_PER_KEY ? candles.slice(-MAX_CANDLES_PER_KEY) : candles)
}

export function prependCandles(symbol: string, tf: string, older: UnifiedCandle[]): void {
  const k = key(symbol, tf)
  const existing = cache.get(k) || []
  const merged = [...older, ...existing]
  cache.set(k, merged.length > MAX_CANDLES_PER_KEY ? merged.slice(-MAX_CANDLES_PER_KEY) : merged)
}

export function updateCandle(symbol: string, tf: string, candle: UnifiedCandle): void {
  const k = key(symbol, tf)
  const arr = cache.get(k)
  if (!arr) return
  const last = arr[arr.length - 1]
  if (last && last.time === candle.time) {
    arr[arr.length - 1] = candle
  } else if (!last || candle.time > last.time) {
    arr.push(candle)
    if (arr.length > MAX_CANDLES_PER_KEY) arr.shift()
  } else {
    const idx = arr.findIndex(c => c.time === candle.time)
    if (idx >= 0) arr[idx] = candle
  }
}

export function storeBulk(data: Record<string, UnifiedCandle[]>): void {
  for (const [k, candles] of Object.entries(data)) {
    cache.set(k, candles.length > MAX_CANDLES_PER_KEY ? candles.slice(-MAX_CANDLES_PER_KEY) : candles)
  }
}

export function hasCandles(symbol: string, tf: string): boolean {
  const arr = cache.get(key(symbol, tf))
  return !!arr && arr.length > 0
}

export function clearAll(): void {
  cache.clear()
}
