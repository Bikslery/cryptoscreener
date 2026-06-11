import api from './api'
import * as candleCache from './candle-cache'
import { expandCompactCandles, type CompactCandle } from './candle-compact'
import type { UnifiedCandle, Exchange } from '../types'

const PREFETCH_LIMIT = 1000

/**
 * Single source of truth for how many candles the chart grid loads.
 * Used by both the bulk prefetch and the per-chart fallback so the two
 * paths never disagree (previously bulk=300 vs individual=500).
 * Mini charts show ~150 visible bars, so 300 leaves scroll headroom;
 * older data is lazy-loaded on scroll.
 */
export const GRID_CANDLE_LIMIT = 300

const inflightMap = new Map<string, Promise<UnifiedCandle[]>>()
const inflightBulk = new Map<string, Promise<Record<string, UnifiedCandle[]>>>()

/**
 * symbol-level registry of in-flight bulk requests.
 * Key: `${exchange ?? 'auto'}:${symbol}:${tf}` → promise that settles when the
 * bulk HTTP attempt finishes (success or failure). getOrFetchHistory awaits it
 * before firing its own request, so the grid's bulk fetch and the 9 individual
 * per-chart fetches no longer race each other (10 requests → 1).
 */
const symbolInflight = new Map<string, Promise<void>>()

function inflightKey(symbol: string, tf: string, before?: number, exchange?: string): string {
  const ex = exchange ?? 'auto'
  return before ? `${ex}:${symbol}:${tf}:${before}` : `${ex}:${symbol}:${tf}`
}

interface CompactBulkResponse {
  format: 'compact'
  data: Record<string, { exchange: Exchange | null; candles: CompactCandle[] }>
}

interface CompactCandlesResponse {
  format: 'compact'
  exchange: Exchange | null
  candles: CompactCandle[]
}

function isCompactBulk(data: unknown): data is CompactBulkResponse {
  return !!data && typeof data === 'object' && (data as { format?: string }).format === 'compact'
}

function isCompactCandles(data: unknown): data is CompactCandlesResponse {
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && (data as { format?: string }).format === 'compact'
}

/** Normalize a candles response (compact or legacy array) to UnifiedCandle[]. */
function normalizeCandlesResponse(
  data: unknown,
  symbol: string,
  tf: string,
  fallbackExchange?: Exchange,
): UnifiedCandle[] {
  if (isCompactCandles(data)) {
    const ex = data.exchange || fallbackExchange
    if (!ex || !data.candles?.length) return []
    return expandCompactCandles(data.candles, symbol, ex, tf)
  }
  return (data as UnifiedCandle[] | undefined) || []
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
  limit: number = GRID_CANDLE_LIMIT,
  exchange?: Exchange,
): Promise<Record<string, UnifiedCandle[]>> {
  // NB: copy before sort — Array.prototype.sort mutates in place, and `symbols`
  // is ChartGrid's memoized topSymbols (prevTopRef.current). Sorting it directly
  // corrupted the cached order to alphabetical, making the grid re-sort on every
  // timeframe / page change. The key only needs to be order-independent.
  const bulkKey = `${exchange ?? 'auto'}:${[...symbols].sort().join(',')}:${tf}:${limit}`
  const existing = inflightBulk.get(bulkKey)
  if (existing) return existing

  const missing: string[] = [...symbols]
  if (missing.length === 0) {
    return Promise.resolve({})
  }

  const request = api.post('/coins/candles-bulk', { symbols: missing, tf, limit, exchange, compact: true })
    .then(res => {
      const result: Record<string, UnifiedCandle[]> = {}
      if (isCompactBulk(res.data)) {
        for (const [symbol, entry] of Object.entries(res.data.data)) {
          const ex = entry.exchange || exchange
          if (ex && entry.candles?.length) {
            const candles = expandCompactCandles(entry.candles, symbol, ex, tf)
            candleCache.setCandles(ex, symbol, tf, candles)
            result[symbol] = candleCache.getCandles(ex, symbol, tf) || candles
          } else {
            result[symbol] = []
          }
        }
        return result
      }
      // Legacy format: Record<string, UnifiedCandle[]>
      const data = res.data as Record<string, UnifiedCandle[]>
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

  // Register the bulk attempt per-symbol so concurrent getOrFetchHistory calls
  // wait for it instead of duplicating the request. Settles on success OR
  // failure (never rejects) — on failure the cache stays empty and the waiter
  // falls through to its own individual fetch.
  const settled = request.then(() => undefined, () => undefined)
  const registeredKeys: string[] = []
  for (const symbol of missing) {
    const k = inflightKey(symbol, tf, undefined, exchange)
    if (!symbolInflight.has(k)) {
      symbolInflight.set(k, settled)
      registeredKeys.push(k)
    }
  }
  settled.then(() => {
    for (const k of registeredKeys) {
      if (symbolInflight.get(k) === settled) symbolInflight.delete(k)
    }
  })

  const promise = request
    .catch(() => {
      // Bulk failed — fall back to individual fetches (registry entries are
      // already settled at this point, so no deadlock).
      const result: Record<string, UnifiedCandle[]> = {}
      const individualPromises = missing.map(async (symbol) => {
        try {
          result[symbol] = await getOrFetchHistory(symbol, tf, limit, exchange)
        } catch {
          result[symbol] = []
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

  const promise = (async (): Promise<UnifiedCandle[]> => {
    // A bulk request covering this symbol is already in flight — wait for it
    // and read from cache instead of duplicating the request.
    const pendingBulk = symbolInflight.get(k)
    if (pendingBulk) {
      await pendingBulk
      if (exchange) {
        const cached = candleCache.getCandles(exchange, symbol, tf)
        if (cached && cached.length > 0) return cached.slice(-limit)
      }
    }

    try {
      const res = await api.get(`/coins/${symbol}/candles`, { params: { tf, limit, exchange, compact: 1 } })
      const data = normalizeCandlesResponse(res.data, symbol, tf, exchange)
      if (data.length) {
        const ex: Exchange = (data[0]?.exchange as Exchange) || (exchange as Exchange)
        if (ex) {
          candleCache.setCandles(ex, symbol, tf, data)
          return candleCache.getCandles(ex, symbol, tf) || data
        }
        return data
      }
      return []
    } catch {
      return []
    }
  })().finally(() => inflightMap.delete(k))

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
  const promise = api.get(`/coins/${symbol}/candles`, { params: { tf, limit, before, exchange, compact: 1 } })
    .then(res => normalizeCandlesResponse(res.data, symbol, tf, exchange))
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
