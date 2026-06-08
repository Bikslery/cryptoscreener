import api from './api'
import * as candleCache from './candle-cache'
import type { UnifiedCandle, Exchange } from '../types'

const PREFETCH_LIMIT = 1000
const inflightMap = new Map<string, Promise<UnifiedCandle[]>>()
const inflightBulk = new Map<string, Promise<Record<string, UnifiedCandle[]>>>()

function inflightKey(symbol: string, tf: string, before?: number, exchange?: string): string {
  const ex = exchange ?? 'auto'
  return before ? `${ex}:${symbol}:${tf}:${before}` : `${ex}:${symbol}:${tf}`
}

/**
 * Bulk-fetch candles for multiple symbols in a single request.
 * Uses /candles-bulk endpoint — much faster than N individual requests
 * because the server can parallelize + use cache.
 *
 * When `exchange` is provided, the server fetches from that specific
 * exchange (e.g. 'binance-spot') instead of the default.
 */
export function getOrFetchBulk(
  symbols: string[],
  tf: string,
  limit: number = PREFETCH_LIMIT,
  exchange?: Exchange,
): Promise<Record<string, UnifiedCandle[]>> {
  // NB: copy before sort — Array.prototype.sort mutates in place, and `symbols`
  // is ChartGrid's memoized topSymbols (prevTopRef.current). Sorting it directly
  // corrupted the cached order to alphabetical, making the grid re-sort on every
  // timeframe / page change. The key only needs to be order-independent.
  const bulkKey = `${exchange ?? 'auto'}:${[...symbols].sort().join(',')}:${tf}:${limit}`
  const existing = inflightBulk.get(bulkKey)
  if (existing) return existing

  const cached: Record<string, UnifiedCandle[]> = {}
  const missing: string[] = [...symbols]

  if (missing.length === 0) {
    return Promise.resolve(cached)
  }

  const promise = api.post('/coins/candles-bulk', { symbols: missing, tf, limit, exchange })
    .then(res => {
      const data = res.data as Record<string, UnifiedCandle[]>
      const result: Record<string, UnifiedCandle[]> = { ...cached }
      for (const [symbol, candles] of Object.entries(data)) {
        if (candles?.length) {
          const ex: Exchange = (candles[0]?.exchange as Exchange) || (exchange as Exchange)
          if (ex) {
            candleCache.setCandles(ex, symbol, tf, candles)
            result[symbol] = candleCache.getCandles(ex, symbol, tf) || candles
          } else {
            result[symbol] = candles
          }
        } else {
          result[symbol] = []
        }
      }
      return result
    })
    .catch(() => {
      const result = { ...cached }
      const individualPromises = missing.map(async (symbol) => {
        try {
          const c = await getOrFetchHistory(symbol, tf, limit, exchange)
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

export function getOrFetchHistory(
  symbol: string,
  tf: string,
  limit: number = PREFETCH_LIMIT,
  exchange?: Exchange,
): Promise<UnifiedCandle[]> {
  const k = inflightKey(symbol, tf, undefined, exchange)
  const existing = inflightMap.get(k)
  if (existing) return existing

  if (exchange) {
    const cached = candleCache.getCandles(exchange, symbol, tf)
    if (cached && cached.length > 0) {
      return Promise.resolve(cached.slice(-limit))
    }
  }

  const promise = api.get(`/coins/${symbol}/candles`, { params: { tf, limit, exchange } })
    .then(res => {
      const data = res.data as UnifiedCandle[]
      if (data?.length) {
        const ex: Exchange = (data[0]?.exchange as Exchange) || (exchange as Exchange)
        if (ex) {
          candleCache.setCandles(ex, symbol, tf, data)
          return candleCache.getCandles(ex, symbol, tf) || data
        }
        return data
      }
      return []
    })
    .catch(() => [])
    .finally(() => inflightMap.delete(k))

  inflightMap.set(k, promise)
  return promise
}

export function getOrFetchOlder(
  symbol: string,
  tf: string,
  before: number,
  limit: number = 1000,
  exchange?: Exchange,
): Promise<UnifiedCandle[]> {
  const k = inflightKey(symbol, tf, before, exchange)
  const existing = inflightMap.get(k)
  if (existing) return existing

  // Bug 4: do NOT swallow errors — let the caller distinguish
  // "empty response" (valid, increment emptyCount) from "server error" (don't block future retries)
  const promise = api.get(`/coins/${symbol}/candles`, { params: { tf, limit, before, exchange } })
    .then(res => {
      const data = res.data as UnifiedCandle[] | undefined
      return data || []
    })
    .catch(err => {
      const error = new Error(err?.message || 'fetch failed') as Error & { isNetworkError?: boolean }
      error.isNetworkError = true
      throw error
    })
    .finally(() => inflightMap.delete(k))

  inflightMap.set(k, promise)
  return promise
}

export function prefetchHistory(symbol: string, tf: string, exchange?: Exchange): void {
  getOrFetchHistory(symbol, tf, PREFETCH_LIMIT, exchange)
}
