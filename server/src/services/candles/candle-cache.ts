import type { UnifiedCandle } from '../../types.js'

const MAX_CANDLES_PER_KEY = 2000
const MAX_TOTAL_CANDLES = 500000

const cache = new Map<string, UnifiedCandle[]>()
const keyOrder: string[] = []
const restKeys = new Set<string>()

function touchKey(key: string) {
  const idx = keyOrder.indexOf(key)
  if (idx !== -1) {
    keyOrder.splice(idx, 1)
  }
  keyOrder.push(key)
}

function totalCandles(): number {
  let total = 0
  for (const arr of cache.values()) total += arr.length
  return total
}

function evictIfNeeded() {
  while (totalCandles() > MAX_TOTAL_CANDLES && keyOrder.length > 0) {
    const oldestKey = keyOrder.shift()!
    cache.delete(oldestKey)
    restKeys.delete(oldestKey)
  }
}

function mergeCandles(existing: UnifiedCandle[], incoming: UnifiedCandle[]): UnifiedCandle[] {
  const map = new Map<number, UnifiedCandle>()
  // Existing first (lower priority on overlap)
  for (const c of existing) map.set(c.time, c)
  // Incoming overwrites on time overlap (new data priority)
  for (const c of incoming) map.set(c.time, c)
  const merged = Array.from(map.values()).sort((a, b) => a.time - b.time)
  return merged.length > MAX_CANDLES_PER_KEY
    ? merged.slice(merged.length - MAX_CANDLES_PER_KEY)
    : merged
}

export function getCachedCandles(symbol: string, tf: string): UnifiedCandle[] | undefined {
  const key = `${symbol}:${tf}`
  const data = cache.get(key)
  if (data) touchKey(key)
  return data
}

export function setCachedCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const key = `${symbol}:${tf}`
  const existing = cache.get(key)
  const merged = existing ? mergeCandles(existing, candles) : candles.slice(0, MAX_CANDLES_PER_KEY)
  cache.set(key, merged)
  touchKey(key)
  evictIfNeeded()
}

export function setCachedCandlesFromRest(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const key = `${symbol}:${tf}`
  setCachedCandles(symbol, tf, candles)
  restKeys.add(key)
}

export function updateCachedCandle(candle: UnifiedCandle): void {
  const key = `${candle.symbol}:${candle.timeframe}`
  const arr = cache.get(key)
  if (!arr) return

  const lastIdx = arr.length - 1
  // If last candle has same time, update it
  if (lastIdx >= 0 && arr[lastIdx].time === candle.time) {
    arr[lastIdx] = candle
    return
  }
  // If new candle time > last, append
  if (lastIdx >= 0 && candle.time > arr[lastIdx].time) {
    arr.push(candle)
    if (arr.length > MAX_CANDLES_PER_KEY) arr.shift()
    touchKey(key)
    return
  }
  // Find and update existing candle by time
  const idx = arr.findIndex(c => c.time === candle.time)
  if (idx !== -1) {
    arr[idx] = candle
  }
}

export function isRestCached(symbol: string, tf: string): boolean {
  return restKeys.has(`${symbol}:${tf}`)
}

export function clearCache(): void {
  cache.clear()
  keyOrder.length = 0
  restKeys.clear()
}

export function getTopCachedSymbols(tf: string, limit: number): string[] {
  // Return symbols that have cached data for the given tf,
  // ordered by most recently touched
  const symbols: string[] = []
  for (let i = keyOrder.length - 1; i >= 0 && symbols.length < limit; i--) {
    const key = keyOrder[i]
    if (key.endsWith(`:${tf}`)) {
      symbols.push(key.split(':')[0])
    }
  }
  return symbols
}

export function getCacheKeys(): string[] {
  return Array.from(cache.keys())
}
