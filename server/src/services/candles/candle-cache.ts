import type { UnifiedCandle, Exchange } from '../../types.js'

const MAX_CANDLES_PER_KEY = 4000
const MAX_TOTAL_CANDLES = 1_500_000

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}

/**
 * How many missing periods a single gap event may be patched with synthetic
 * flat candles (open=high=low=close=prevClose, volume 0). Bounded so a
 * multi-day WS outage can't balloon the cache into thousands of filler rows —
 * big gaps are left as-is for the serve-time fill + async repair to handle.
 */
const MAX_FILL_WINDOW = 120

let syntheticFilledTotal = 0

export function getSyntheticFillCount(): number {
  return syntheticFilledTotal
}

/** A flat "no-activity" candle anchored to the previous close (TradingView-style
 *  continuity). volume is 0 and OHLC are all the previous close — these are
 *  placeholders until the async cache repair replaces them with real rows. */
function flatCandle(anchor: { symbol: string; exchange: Exchange; timeframe: string }, time: number, prevClose: number): UnifiedCandle {
  return {
    symbol: anchor.symbol,
    exchange: anchor.exchange,
    timeframe: anchor.timeframe,
    time,
    open: prevClose,
    high: prevClose,
    low: prevClose,
    close: prevClose,
    volume: 0,
    isFinal: true,
  }
}

/**
 * Insert flat candles for every missing period so the returned series is
 * CONTIGUOUS — a client must never paint a hole regardless of where it came
 * from (memory cache, Redis chunk, exchange). Cheap O(n) single pass; returns
 * the input unchanged when there is nothing to fill. Assumes sorted input.
 */
export function fillGaps(candles: UnifiedCandle[], symbol: string, exchange: Exchange, tf: string): UnifiedCandle[] {
  const tfSec = TF_SECONDS[tf]
  if (!tfSec || candles.length < 2) return candles
  let prev: UnifiedCandle | null = null
  let output: UnifiedCandle[] | null = null
  for (const c of candles) {
    if (prev && c.time > prev.time) {
      const diff = c.time - prev.time
      const periods = Math.round(diff / tfSec)
      if (periods > 1) {
        const missing = Math.min(periods - 1, MAX_FILL_WINDOW)
        if (missing > 0) {
          if (!output) output = candles.slice(0, candles.indexOf(c))
          for (let i = 1; i <= missing; i++) {
            output.push(flatCandle(c, prev.time + i * tfSec, prev.close))
            syntheticFilledTotal++
          }
          output.push(c)
          continue
        }
      }
    }
    if (output) output.push(c)
    prev = c
  }
  return output || candles
}

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
    // The stream skipped one or more periods (Binance hiccup, WS reconnect,
    // backpressure). Fill the skipped buckets with flat candles NOW so the
    // cache never holds a permanent hole — a real row replaces the filler
    // later via the async repair or the next cache write.
    let added = 1
    const tfSec = TF_SECONDS[candle.timeframe]
    if (tfSec) {
      const diff = candle.time - arr[lastIdx].time
      const periods = Math.round(diff / tfSec)
      const missing = Math.min(periods - 1, MAX_FILL_WINDOW)
      if (missing > 0) {
        const prevClose = arr[lastIdx].close
        for (let i = 1; i <= missing; i++) {
          arr.push(flatCandle(candle, arr[lastIdx].time + i * tfSec, prevClose))
          syntheticFilledTotal++
        }
        added += missing
      }
    }
    arr.push(candle)
    totalCandleCount += added
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
const seen = new Set<string>()
const keys = lru.keysFromRecent()
for (const key of keys) {
  if (symbols.length >= limit) break
  if (key.endsWith(`:${tf}`)) {
    const parts = key.split(':')
    // Key format: "${exchange}:${symbol}:${tf}" → symbol is parts[1]
    const symbol = parts.length >= 3 ? parts[1] : parts[0]
    if (!seen.has(symbol)) {
      seen.add(symbol)
      symbols.push(symbol)
    }
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
  // Key format: "${exchange}:${symbol}:${tf}" (3 parts) or "${symbol}:${tf}" (2 parts legacy)
  const tf = parts.length >= 3 ? parts[2] : (parts[1] || 'unknown')
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
