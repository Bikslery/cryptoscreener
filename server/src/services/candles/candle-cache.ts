import type { UnifiedCandle, Exchange } from '../../types.js'

const MAX_CANDLES_PER_KEY = 2000
const MAX_TOTAL_CANDLES = 1_500_000

class LRU {
private map = new Map<string, { prev: string | null; next: string | null }>()
private head: string | null = null
private tail: string | null = null

touch(key: string) {
  if (!this.map.has(key)) {
    this.map.set(key, { prev: null, next: this.head })
    if (this.head !== null) {
      const h = this.map.get(this.head)!
      h.prev = key
    }
    this.head = key
    if (this.tail === null) this.tail = key
    return
  }
  const node = this.map.get(key)!
  if (this.head === key) return
  this.detach(key, node)
  node.prev = null
  node.next = this.head
  if (this.head !== null) {
    const h = this.map.get(this.head)!
    h.prev = key
  }
  this.head = key
}

private detach(key: string, node: { prev: string | null; next: string | null }) {
  if (node.prev !== null) {
    const p = this.map.get(node.prev)!
    p.next = node.next
  } else {
    this.head = node.next
  }
  if (node.next !== null) {
    const n = this.map.get(node.next)!
    n.prev = node.prev
  } else {
    this.tail = node.prev
  }
}

evictTail(): string | null {
  if (this.tail === null) return null
  const key = this.tail
  const node = this.map.get(key)!
  this.map.delete(key)
  this.tail = node.prev
  if (this.tail !== null) {
    const t = this.map.get(this.tail)!
    t.next = null
  } else {
    this.head = null
  }
  return key
}

has(key: string): boolean {
  return this.map.has(key)
}

get size(): number {
  return this.map.size
}

keysFromRecent(): string[] {
  const result: string[] = []
  let cur = this.head
  while (cur !== null) {
    result.push(cur)
    const node = this.map.get(cur)
    cur = node ? node.next : null
  }
  return result
}
}

const cache = new Map<string, UnifiedCandle[]>()
const lru = new LRU()
const restKeys = new Set<string>()
let totalCandleCount = 0

function evictIfNeeded() {
while (totalCandleCount > MAX_TOTAL_CANDLES) {
  const key = lru.evictTail()
  if (key === null) break
  const arr = cache.get(key)
  if (arr) totalCandleCount -= arr.length
  cache.delete(key)
  restKeys.delete(key)
}
}

function mergeCandles(existing: UnifiedCandle[], incoming: UnifiedCandle[]): UnifiedCandle[] {
const map = new Map<number, UnifiedCandle>()
for (const c of existing) map.set(c.time, c)
for (const c of incoming) map.set(c.time, c)
const merged = Array.from(map.values()).sort((a, b) => a.time - b.time)
return merged.length > MAX_CANDLES_PER_KEY
  ? merged.slice(merged.length - MAX_CANDLES_PER_KEY)
  : merged
}

export function getCachedCandles(symbol: string, tf: string, exchange?: Exchange): UnifiedCandle[] | undefined {
  // If exchange is specified, use exchange-aware key
  if (exchange) {
    const key = `${exchange}:${symbol}:${tf}`
    const data = cache.get(key)
    if (data) lru.touch(key)
    return data
  }
  // Fallback: try without exchange (backward compatibility for REST routes)
  const key = `${symbol}:${tf}`
  const data = cache.get(key)
  if (data) lru.touch(key)
  return data
}

export function setCachedCandles(symbol: string, tf: string, candles: UnifiedCandle[], exchange?: Exchange): void {
  // Use exchange from candles if available, otherwise from parameter
  const ex = exchange || candles[0]?.exchange
  const key = ex ? `${ex}:${symbol}:${tf}` : `${symbol}:${tf}`
  const existing = cache.get(key)
  if (existing) totalCandleCount -= existing.length
  const merged = existing ? mergeCandles(existing, candles) : candles.slice(0, MAX_CANDLES_PER_KEY)
  cache.set(key, merged)
  totalCandleCount += merged.length
  lru.touch(key)
  evictIfNeeded()
}

export function setCachedCandlesFromRest(symbol: string, tf: string, candles: UnifiedCandle[], exchange?: Exchange): void {
  const ex = exchange || candles[0]?.exchange
  const key = ex ? `${ex}:${symbol}:${tf}` : `${symbol}:${tf}`
  setCachedCandles(symbol, tf, candles, exchange)
  restKeys.add(key)
}

export function updateCachedCandle(candle: UnifiedCandle): void {
  // Use exchange-aware key
  const key = `${candle.exchange}:${candle.symbol}:${candle.timeframe}`
  const arr = cache.get(key)
  if (!arr) return

  const lastIdx = arr.length - 1
  if (lastIdx >= 0 && arr[lastIdx].time === candle.time) {
    arr[lastIdx] = candle
    return
  }
  if (lastIdx >= 0 && candle.time > arr[lastIdx].time) {
    arr.push(candle)
    totalCandleCount++
    if (arr.length > MAX_CANDLES_PER_KEY + 200) {
      const excess = arr.length - MAX_CANDLES_PER_KEY
      arr.splice(0, excess)
      totalCandleCount -= excess
    }
    lru.touch(key)
    return
  }
  const idx = arr.findIndex(c => c.time === candle.time)
  if (idx !== -1) {
    arr[idx] = candle
  }
}

export function isRestCached(symbol: string, tf: string, exchange?: Exchange): boolean {
  if (exchange) {
    return restKeys.has(`${exchange}:${symbol}:${tf}`)
  }
  return restKeys.has(`${symbol}:${tf}`)
}

export function clearCache(): void {
cache.clear()
totalCandleCount = 0
restKeys.clear()
}

export function getTopCachedSymbols(tf: string, limit: number): string[] {
const symbols: string[] = []
const keys = lru.keysFromRecent()
for (const key of keys) {
  if (symbols.length >= limit) break
  if (key.endsWith(`:${tf}`)) {
    symbols.push(key.split(':')[0])
  }
}
return symbols
}

export function getCacheKeys(): string[] {
return Array.from(cache.keys())
}

export function getCacheStats() {
const byTimeframe: Record<string, { symbols: number; candles: number; restCached: number }> = {}
for (const [key, candles] of cache) {
  const parts = key.split(':')
  const tf = parts[1] || 'unknown'
  const stats = byTimeframe[tf] || { symbols: 0, candles: 0, restCached: 0 }
  stats.symbols++
  stats.candles += candles.length
  if (restKeys.has(key)) stats.restCached++
  byTimeframe[tf] = stats
}
return {
  totalCandles: totalCandleCount,
  totalKeys: cache.size,
  maxTotalCandles: MAX_TOTAL_CANDLES,
  maxCandlesPerKey: MAX_CANDLES_PER_KEY,
  byTimeframe,
}
}
