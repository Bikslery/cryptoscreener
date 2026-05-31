import type { UnifiedCandle } from '../types'

// Reasonable limit: ~5000 candles per symbol+tf pair keeps memory bounded
// (5000 * 8 fields * 8 bytes ≈ 320KB per key max)
const MAX_CANDLES_PER_KEY = 5000
const MAX_TOTAL_CANDLES = 300_000

const cache = new Map<string, UnifiedCandle[]>()
const lruOrder: string[] = []  // most-recent at end
let totalCandleCount = 0

function key(symbol: string, tf: string): string {
  return `${symbol}:${tf}`
}

function touchLru(k: string) {
  const idx = lruOrder.indexOf(k)
  if (idx !== -1) lruOrder.splice(idx, 1)
  lruOrder.push(k)
}

function evictIfNeeded() {
  while (totalCandleCount > MAX_TOTAL_CANDLES && lruOrder.length > 0) {
    const oldest = lruOrder.shift()!
    const arr = cache.get(oldest)
    if (arr) totalCandleCount -= arr.length
    cache.delete(oldest)
  }
}

function validateCandle(c: UnifiedCandle): boolean {
  // Validate all OHLC fields are finite numbers
  if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
    return false
  }
  // Validate OHLC relationships
  if (c.high < c.low) return false
  if (c.high < c.open || c.high < c.close) return false
  if (c.low > c.open || c.low > c.close) return false
  // Validate volume and time
  if (!isFinite(c.volume) || c.volume < 0) return false
  if (!c.time || c.time <= 0) return false
  return true
}

function dedupSort(candles: UnifiedCandle[]): UnifiedCandle[] {
  if (candles.length <= 1) return candles
  // Filter out invalid candles before dedup
  const valid = candles.filter(validateCandle)
  const byTime = new Map<number, UnifiedCandle>()
  for (const c of valid) byTime.set(c.time, c)
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time)
}

function trimToLimit(candles: UnifiedCandle[]): UnifiedCandle[] {
  return candles.length > MAX_CANDLES_PER_KEY
    ? candles.slice(-MAX_CANDLES_PER_KEY)
    : candles
}

export function getCandles(symbol: string, tf: string): UnifiedCandle[] | undefined {
  const k = key(symbol, tf)
  const data = cache.get(k)
  if (data) touchLru(k)
  return data
}

export function setCandles(symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const k = key(symbol, tf)
  const existing = cache.get(k)
  if (existing) {
    totalCandleCount -= existing.length
    const merged = dedupSort([...existing, ...candles])
    const trimmed = trimToLimit(merged)
    cache.set(k, trimmed)
    totalCandleCount += trimmed.length
  } else {
    const deduped = dedupSort(candles)
    const trimmed = trimToLimit(deduped)
    cache.set(k, trimmed)
    totalCandleCount += trimmed.length
  }
  touchLru(k)
  evictIfNeeded()
}

export function prependCandles(symbol: string, tf: string, older: UnifiedCandle[]): void {
  if (older.length === 0) return
  const k = key(symbol, tf)
  const existing = cache.get(k) || []
  totalCandleCount -= existing.length

  const byTime = new Map<number, UnifiedCandle>()
  for (const c of older) byTime.set(c.time, c)
  for (const c of existing) byTime.set(c.time, c)
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time)
  const trimmed = trimToLimit(merged)
  cache.set(k, trimmed)
  totalCandleCount += trimmed.length
  touchLru(k)
  evictIfNeeded()
}

export function updateCandle(symbol: string, tf: string, candle: UnifiedCandle): void {
  // Validate before updating cache
  if (!validateCandle(candle)) {
    console.warn('[candle-cache] Invalid candle rejected', { symbol, tf, time: candle.time })
    return
  }

  const k = key(symbol, tf)
  const arr = cache.get(k)
  if (!arr) return
  const last = arr[arr.length - 1]
  if (last && last.time === candle.time) {
    arr[arr.length - 1] = candle
  } else if (!last || candle.time > last.time) {
    arr.push(candle)
    totalCandleCount++
    if (arr.length > MAX_CANDLES_PER_KEY + 200) {
      const excess = arr.length - MAX_CANDLES_PER_KEY
      arr.splice(0, excess)
      totalCandleCount -= excess
    }
    touchLru(k)
  } else {
    const idx = arr.findIndex(c => c.time === candle.time)
    if (idx >= 0) arr[idx] = candle
  }
}

export function storeBulk(data: Record<string, UnifiedCandle[]>): void {
  for (const [k, candles] of Object.entries(data)) {
    const deduped = dedupSort(candles)
    const trimmed = trimToLimit(deduped)
    const existing = cache.get(k)
    if (existing) totalCandleCount -= existing.length
    cache.set(k, trimmed)
    totalCandleCount += trimmed.length
    touchLru(k)
  }
  evictIfNeeded()
}

export function hasCandles(symbol: string, tf: string): boolean {
  const arr = cache.get(key(symbol, tf))
  return !!arr && arr.length > 0
}

export function clearAll(): void {
  cache.clear()
  lruOrder.length = 0
  totalCandleCount = 0
}
