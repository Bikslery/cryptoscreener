import type { UnifiedCandle, Exchange } from '../types'
import { validateCandle, normalizeCandle } from './candle-utils'
import { loadCandleTail, persistCandleTail } from './candle-persistence'

const MAX_CANDLES_PER_KEY = 10000
const MAX_TOTAL_CANDLES = 300_000

const cache = new Map<string, UnifiedCandle[]>()
const lruOrder = new Set<string>()
let totalCandleCount = 0
const hydrateInflight = new Map<string, Promise<UnifiedCandle[] | undefined>>()

function key(exchange: Exchange, symbol: string, tf: string): string {
  return `${exchange}:${symbol}:${tf}`
}

function touchLru(k: string) {
  lruOrder.delete(k)
  lruOrder.add(k)
}

function evictIfNeeded() {
  while (totalCandleCount > MAX_TOTAL_CANDLES && lruOrder.size > 0) {
    const oldest = lruOrder.values().next().value as string
    lruOrder.delete(oldest)
    const arr = cache.get(oldest)
    if (arr) totalCandleCount -= arr.length
    cache.delete(oldest)
  }
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

export function getCandles(exchange: Exchange, symbol: string, tf: string): UnifiedCandle[] | undefined {
  const k = key(exchange, symbol, tf)
  const data = cache.get(k)
  if (data) touchLru(k)
  return data
}

export function setCandles(exchange: Exchange, symbol: string, tf: string, candles: UnifiedCandle[]): void {
  const k = key(exchange, symbol, tf)
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
  const stored = cache.get(k)
  if (stored) persistCandleTail(exchange, symbol, tf, stored)
}

export function prependCandles(exchange: Exchange, symbol: string, tf: string, older: UnifiedCandle[]): void {
  if (older.length === 0) return
  const k = key(exchange, symbol, tf)

  // Read current array RIGHT before merge to capture any updateCandle
  // mutations that happened since this function was called. updateCandle
  // mutates the cached array in-place, so re-reading is essential.
  const current = cache.get(k) || []
  totalCandleCount -= current.length

  // Filter invalid candles from the incoming older page — dedupSort/setCandles
  // already do this for the initial-history and bulk paths; prependCandles
  // used to skip it, which let a malformed API candle slip into the cache
  // silently AND made `merged.length` disagree with what useFullHistory's
  // renderCandles ends up putting in candlesDataRef (which always filters via
  // validateCandle). That disagreement is exactly what makes the lazy-scroll
  // `added = merged.length - prevLen` viewport-shift calc drift by however
  // many candles got silently dropped downstream — filtering HERE keeps the
  // cache's length authoritative and the shift calc exact.
  const validOlder = older.filter(validateCandle)

  const byTime = new Map<number, UnifiedCandle>()
  for (const c of validOlder) byTime.set(c.time, c)
  // current entries overwrite older at same timestamp (current is authoritative)
  // and include any in-place mutations from updateCandle
  for (const c of current) byTime.set(c.time, c)
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time)
  const trimmed = trimToLimit(merged)
  cache.set(k, trimmed)
  totalCandleCount += trimmed.length
  touchLru(k)
  evictIfNeeded()
  persistCandleTail(exchange, symbol, tf, trimmed)
}

export function updateCandle(exchange: Exchange, symbol: string, tf: string, candle: UnifiedCandle): void {
  const normalized = normalizeCandle(candle)
  if (!validateCandle(normalized)) {
    console.warn('[candle-cache] Invalid candle rejected', { exchange, symbol, tf, time: candle.time })
    return
  }

  const k = key(exchange, symbol, tf)
  const arr = cache.get(k)
  if (!arr) return
  const last = arr[arr.length - 1]
  if (last && last.time === normalized.time) {
    arr[arr.length - 1] = normalized
  } else if (!last || normalized.time > last.time) {
    arr.push(normalized)
    totalCandleCount++
    if (arr.length > MAX_CANDLES_PER_KEY + 200) {
      const excess = arr.length - MAX_CANDLES_PER_KEY
      arr.splice(0, excess)
      totalCandleCount -= excess
    }
    touchLru(k)
  } else {
    // Sorted upsert: replace if present, otherwise insert at the right index.
    // Gap backfill (applyOlderPage) writes candles that sit BETWEEN existing
    // entries — without the insert they never reached the cache and vanished
    // again on the next setData() rebuild, re-opening the hole.
    const idx = arr.findIndex(c => c.time >= normalized.time)
    if (idx >= 0 && arr[idx].time === normalized.time) {
      arr[idx] = normalized
    } else if (idx >= 0) {
      arr.splice(idx, 0, normalized)
      totalCandleCount++
      if (arr.length > MAX_CANDLES_PER_KEY + 200) {
        const excess = arr.length - MAX_CANDLES_PER_KEY
        arr.splice(0, excess)
        totalCandleCount -= excess
      }
    }
  }
  persistCandleTail(exchange, symbol, tf, arr)
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
    const [exchange, symbol, tf] = k.split(':')
    if (exchange && symbol && tf) persistCandleTail(exchange as Exchange, symbol, tf, trimmed)
  }
  evictIfNeeded()
}

export function hasCandles(exchange: Exchange, symbol: string, tf: string): boolean {
  const arr = cache.get(key(exchange, symbol, tf))
  return !!arr && arr.length > 0
}

export function clearAll(): void {
  cache.clear()
  lruOrder.clear()
  totalCandleCount = 0
  hydrateInflight.clear()
}

/** Load one persisted tail without ever overwriting fresher in-memory data. */
export function hydratePersistentCandles(exchange: Exchange, symbol: string, tf: string): Promise<UnifiedCandle[] | undefined> {
  const k = key(exchange, symbol, tf)
  const existing = cache.get(k)
  if (existing?.length) return Promise.resolve(existing)
  const active = hydrateInflight.get(k)
  if (active) return active
  const promise = loadCandleTail(exchange, symbol, tf)
    .then(candles => {
      const arrivedWhileLoading = cache.get(k)
      if (arrivedWhileLoading?.length) return arrivedWhileLoading
      if (candles.length === 0) return undefined
      setCandles(exchange, symbol, tf, candles)
      return cache.get(k)
    })
    .finally(() => hydrateInflight.delete(k))
  hydrateInflight.set(k, promise)
  return promise
}
