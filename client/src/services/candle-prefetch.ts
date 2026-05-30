import api from './api'
import * as candleCache from './candle-cache'
import type { UnifiedCandle } from '../types'

const PREFETCH_LIMIT = 1000
const inflightMap = new Map<string, Promise<UnifiedCandle[]>>()
const inflightBulk = new Map<string, Promise<Record<string, UnifiedCandle[]>>>()

function inflightKey(symbol: string, tf: string, before?: number): string {
  return before ? `${symbol}:${tf}:${before}` : `${symbol}:${tf}`
}

/**
 * Bulk-fetch candles for multiple symbols in a single request.
 * Uses /candles-bulk endpoint — much faster than N individual requests
 * because the server can parallelize + use cache.
 */
export function getOrFetchBulk(
  symbols: string[],
  tf: string,
  limit: number = PREFETCH_LIMIT,
): Promise<Record<string, UnifiedCandle[]>> {
  const bulkKey = `${symbols.sort().join(',')}:${tf}:${limit}`
  const existing = inflightBulk.get(bulkKey)
  if (existing) return existing

  // Check which symbols already have cached data
  const cached: Record<string, UnifiedCandle[]> = {}
  const missing: string[] = []
  for (const symbol of symbols) {
    const c = candleCache.getCandles(symbol, tf)
    if (c && c.length >= limit) {
      cached[symbol] = c
    } else {
      missing.push(symbol)
    }
  }

  if (missing.length === 0) {
    return Promise.resolve(cached)
  }

  const promise = api.post('/coins/candles-bulk', { symbols: missing, tf, limit })
    .then(res => {
      const data = res.data as Record<string, UnifiedCandle[]>
      const result: Record<string, UnifiedCandle[]> = { ...cached }
      for (const [symbol, candles] of Object.entries(data)) {
        if (candles?.length) {
          candleCache.setCandles(symbol, tf, candles)
          result[symbol] = candleCache.getCandles(symbol, tf) || candles
        } else {
          const prev = candleCache.getCandles(symbol, tf)
          result[symbol] = prev || []
        }
      }
      return result
    })
    .catch(() => {
      // Fallback: try individual fetches for missing symbols
      const result = { ...cached }
      const individualPromises = missing.map(async (symbol) => {
        try {
          const c = await getOrFetchHistory(symbol, tf, limit)
          result[symbol] = c
        } catch {
          result[symbol] = cached[symbol] || []
        }
      })
      return Promise.all(individualPromises).then(() => result)
    })
    .finally(() => inflightBulk.delete(bulkKey))

  inflightBulk.set(bulkKey, promise)
  return promise
}

export function getOrFetchHistory(symbol: string, tf: string, limit: number = PREFETCH_LIMIT): Promise<UnifiedCandle[]> {
  const k = inflightKey(symbol, tf)
  const existing = inflightMap.get(k)
  if (existing) return existing

  const cached = candleCache.getCandles(symbol, tf)
  if (cached && cached.length >= limit) return Promise.resolve(cached)

  const promise = api.get(`/coins/${symbol}/candles`, { params: { tf, limit } })
    .then(res => {
      const data = res.data as UnifiedCandle[]
      if (data?.length) {
        candleCache.setCandles(symbol, tf, data)
        return candleCache.getCandles(symbol, tf) || data
      }
      return cached || []
    })
    .catch(() => cached || [])
    .finally(() => inflightMap.delete(k))

  inflightMap.set(k, promise)
  return promise
}

export function getOrFetchOlder(symbol: string, tf: string, before: number, limit: number = 1000): Promise<UnifiedCandle[]> {
  const k = inflightKey(symbol, tf, before)
  const existing = inflightMap.get(k)
  if (existing) return existing

  // Bug 4: do NOT swallow errors — let the caller distinguish
  // "empty response" (valid, increment emptyCount) from "server error" (don't block future retries)
  const promise = api.get(`/coins/${symbol}/candles`, { params: { tf, limit, before } })
    .then(res => {
      const data = res.data as UnifiedCandle[] | undefined
      return data || []
    })
    .catch(err => {
      // Re-throw with a marker so the caller can tell it's a network/server error
      // and NOT count it toward emptyCountRef
      const error = new Error(err?.message || 'fetch failed') as Error & { isNetworkError?: boolean }
      error.isNetworkError = true
      throw error
    })
    .finally(() => inflightMap.delete(k))

  inflightMap.set(k, promise)
  return promise
}

export function prefetchHistory(symbol: string, tf: string): void {
  getOrFetchHistory(symbol, tf)
}
