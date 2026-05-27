import type { UnifiedCandle } from '../../types.js'

const MAX_CANDLES_PER_KEY = 2000
const MAX_TOTAL_CANDLES = 500000

const cache = new Map<string, UnifiedCandle[]>()
const keyOrder: string[] = []
const restKeys = new Set<string>()

function makeKey(symbol: string, tf: string): string {
  return `${symbol}:${tf}`
}

function touchKey(key: string): void {
  const idx = keyOrder.indexOf(key)
  if (idx !== -1) {
    keyOrder.splice(idx, 1)
  }
  keyOrder.push(key)
}

function totalCandles(): number {
  let total = 0
  for (const arr of cache.values()) {
    total += arr.length
  }
  return total
}

function evictIfNeeded(): void {
  while (totalCandles() > MAX_TOTAL_CANDLES && keyOrder.length > 0) {
    const lruKey = keyOrder.shift()!
    cache.delete(lruKey)
    restKeys.delete(lruKey)
  }
}

function mergeCandles(existing: UnifiedCandle[], incoming: UnifiedCandle[]): UnifiedCandle[] {
  const map = new Map<number, UnifiedCandle>()
  for (const c of existing) {
    map.set(c.time, c)
  }
  for (const c of incoming) {
    map.set(c.time, c) // incoming takes priority on overlap
  }
  const merged = Array.from(map.values()).sort((a, b) => a.time - b.time)
  if (merged.length > MAX_CANDLES_PER_KEY) {
    return merged.slice(merged.length - MAX_CANDLES_PER_KEY)
  }
  return merged
}

export function getCachedCandles(symbol: string, tf: string): UnifiedCandle[] | undefined {
  const key = makeKey(symbol, tf)
  const candles = cache.get(key)
  if (candles !== undefined) {
    touchKey(key)
  }
  return candles
}

export function setCachedCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const key = makeKey(symbol, tf)
  const existing = cache.get(key)
  if (existing) {
    cache.set(key, mergeCandles(existing, candles))
  } else {
    let trimmed = candles
    if (trimmed.length > MAX_CANDLES_PER_KEY) {
      trimmed = trimmed.slice(trimmed.length - MAX_CANDLES_PER_KEY)
    }
    cache.set(key, trimmed)
  }
  touchKey(key)
  evictIfNeeded()
}

export function setCachedCandlesFromRest(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const key = makeKey(symbol, tf)
  setCachedCandles(symbol, tf, candles)
  restKeys.add(key)
}

export function updateCachedCandle(candle: UnifiedCandle): void {
  const key = makeKey(candle.symbol, candle.timeframe)
  const arr = cache.get(key)
  if (!arr) {
    // No cached data for this key; just set a single-candle array
    cache.set(key, [candle])
    touchKey(key)
    evictIfNeeded()
    return
  }

  const lastCandle = arr[arr.length - 1]
  if (lastCandle && lastCandle.time === candle.time) {
    // Update last candle in place
    arr[arr.length - 1] = candle
  } else if (lastCandle && candle.time > lastCandle.time) {
    // Append new candle
    arr.push(candle)
    if (arr.length > MAX_CANDLES_PER_KEY) {
      arr.shift()
    }
  } else {
    // Candle time is older than last; find and update or insert
    const idx = arr.findIndex(c => c.time === candle.time)
    if (idx !== -1) {
      arr[idx] = candle
    } else {
      // Insert in sorted order
      arr.push(candle)
      arr.sort((a, b) => a.time - b.time)
      if (arr.length > MAX_CANDLES_PER_KEY) {
        arr.splice(0, arr.length - MAX_CANDLES_PER_KEY)
      }
    }
  }

  touchKey(key)
  evictIfNeeded()
}

export function isRestCached(symbol: string, tf: string): boolean {
  const key = makeKey(symbol, tf)
  return restKeys.has(key)
}

export function clearCache(): void {
  cache.clear()
  keyOrder.length = 0
  restKeys.clear()
}

export function getTopCachedSymbols(tf: string, limit: number): string[] {
  const counts: { symbol: string; count: number }[] = []
  for (const [key, arr] of cache) {
    if (key.endsWith(`:${tf}`)) {
      const symbol = key.slice(0, key.length - tf.length - 1)
      counts.push({ symbol, count: arr.length })
    }
  }
  counts.sort((a, b) => b.count - a.count)
  return counts.slice(0, limit).map(c => c.symbol)
}

export function getCacheKeys(): string[] {
  return Array.from(cache.keys())
}
