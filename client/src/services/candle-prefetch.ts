import api from './api'
import * as candleCache from './candle-cache'
import { expandCompactCandles, type CompactCandle } from './candle-compact'
import type { UnifiedCandle, Exchange } from '../types'

const PREFETCH_LIMIT = 3000

/**
 * How many candles the expanded (big) chart loads in one go so the open
 * view is maximally zoomed out with the left side already covered by
 * history (server MAX_CANDLE_LIMIT allows this in a single request).
 */
export const EXPANDED_CANDLE_LIMIT = 3000

/**
 * How long a per-symbol history request will wait for the in-flight bulk
 * request before firing its own individual fetch. Keeps first paint fast
 * even when one symbol in the grid bulk is slow.
 *
 * 2500ms (was 350ms): the server's candles-bulk now bounds every symbol to a
 * ~1.2s deadline, so the bulk settles fast in practice — and when it does,
 * the individual fallback must NOT duplicate the request (the 350ms race
 * fired 9 duplicate REST calls into the server on every cold page load).
 */
const BULK_WAIT_MS = 2500

/**
 * Single source of truth for how many candles the chart grid loads.
 * Used by both the bulk prefetch and the per-chart fallback so the two
 * paths never disagree (previously bulk=300 vs individual=500).
 * Mini charts show ~150 visible bars, so 300 leaves scroll headroom;
 * older data is lazy-loaded on scroll.
 */
export const GRID_CANDLE_LIMIT = 300

interface InflightEntry<T> {
  promise: Promise<T>
  ts: number
}

/**
 * In-flight requests are remembered for at most INFLIGHT_MAX_AGE_MS. Without
 * an expiry, a request that NEVER settles (server stall, dead axios promise)
 * poisoned its key forever: every later attempt returned the same dead
 * promise and the chart stayed blank until a page reload wiped the memory.
 */
const INFLIGHT_MAX_AGE_MS = 20_000

const inflightMap = new Map<string, InflightEntry<UnifiedCandle[]>>()
const inflightBulk = new Map<string, InflightEntry<Record<string, UnifiedCandle[]>>>()

/**
 * symbol-level registry of in-flight bulk requests.
 * Key: `${exchange ?? 'auto'}:${symbol}:${tf}` → promise that settles when the
 * bulk HTTP attempt finishes (success or failure). getOrFetchHistory awaits it
 * before firing its own request, so the grid's bulk fetch and the 9 individual
 * per-chart fetches no longer race each other (10 requests → 1).
 */
const symbolInflight = new Map<string, InflightEntry<void>>()

function freshEntry<T>(promise: Promise<T>): InflightEntry<T> {
  return { promise, ts: Date.now() }
}

function getFreshEntry<T>(map: Map<string, InflightEntry<T>>, key: string): InflightEntry<T> | undefined {
  const entry = map.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.ts > INFLIGHT_MAX_AGE_MS) {
    map.delete(key)
    return undefined
  }
  return entry
}

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
  const existingBulk = getFreshEntry(inflightBulk, bulkKey)
  if (existingBulk) return existingBulk.promise

  // Client-cache fast path: symbols whose cached history already covers the
  // request resolve instantly, with zero network round-trips. Repeated page
  // views and timeframe flips (same exchange) paint straight from memory.
  // Only valid when the exchange is known — in auto mode the server picks the
  // source, so the client cache key can't be trusted to match.
  const cachedResult: Record<string, UnifiedCandle[]> = {}
  const missing: string[] = []
  if (exchange) {
    for (const symbol of symbols) {
      const cached = candleCache.getCandles(exchange, symbol, tf)
      if (cached && cached.length >= limit) {
        cachedResult[symbol] = cached.slice(-limit)
      } else {
        missing.push(symbol)
      }
    }
  } else {
    missing.push(...symbols)
  }
  if (missing.length === 0) {
    return Promise.resolve(cachedResult)
  }

  // Bidirectional dedupe: child chart effects can begin an individual GET
  // before the parent registers its bulk request. Reuse those exact 300-bar
  // promises and exclude their symbols from POST /candles-bulk, otherwise a
  // cold grid can issue both transports for the same symbol.
  const reusedIndividuals: Array<{ symbol: string; promise: Promise<UnifiedCandle[]> }> = []
  const missingForBulk: string[] = []
  for (const symbol of missing) {
    const individualKey = `${exchange ?? 'auto'}:${symbol}:${tf}:${limit}`
    const individual = getFreshEntry(inflightMap, individualKey)
    if (individual) reusedIndividuals.push({ symbol, promise: individual.promise })
    else missingForBulk.push(symbol)
  }

  const mergeReusedIndividuals = async (result: Record<string, UnifiedCandle[]>) => {
    await Promise.all(reusedIndividuals.map(async ({ symbol, promise }) => {
      try { result[symbol] = await promise } catch { result[symbol] = [] }
    }))
    return result
  }

  if (missingForBulk.length === 0) {
    return mergeReusedIndividuals({ ...cachedResult })
  }

  const request = api.post('/coins/candles-bulk', { symbols: missingForBulk, tf, limit, exchange, compact: true })
    .then(async res => {
      const result: Record<string, UnifiedCandle[]> = { ...cachedResult }
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
        return mergeReusedIndividuals(result)
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
      return mergeReusedIndividuals(result)
    })

  // Register the bulk attempt per-symbol so concurrent getOrFetchHistory calls
  // wait for it instead of duplicating the request. Settles on success OR
  // failure (never rejects) — on failure the cache stays empty and the waiter
  // falls through to its own individual fetch.
  const settled = request.then(() => undefined, () => undefined)
  const registeredKeys: string[] = []
  for (const symbol of missingForBulk) {
    const k = inflightKey(symbol, tf, undefined, exchange)
    if (!symbolInflight.has(k)) {
      symbolInflight.set(k, freshEntry(settled))
      registeredKeys.push(k)
    }
  }
  settled.then(() => {
    for (const k of registeredKeys) {
      if (symbolInflight.get(k)?.promise === settled) symbolInflight.delete(k)
    }
  })

  const promise = request
    .catch(() => {
      // Bulk failed — fall back to individual fetches (registry entries are
      // already settled at this point, so no deadlock).
      const result: Record<string, UnifiedCandle[]> = {}
      const individualPromises = missingForBulk.map(async (symbol) => {
        try {
          result[symbol] = await getOrFetchHistory(symbol, tf, limit, exchange)
        } catch {
          result[symbol] = []
        }
      })
      return Promise.all(individualPromises).then(() => mergeReusedIndividuals(result))
    })
    .finally(() => inflightBulk.delete(bulkKey))

  inflightBulk.set(bulkKey, freshEntry(promise))
  return promise
}

export function getOrFetchHistory(
  symbol: string,
  tf: string,
  limit: number = PREFETCH_LIMIT,
  exchange?: Exchange,
  force = false,
): Promise<UnifiedCandle[]> {
  // Limit-aware key: a 300-bar mini-chart fetch and a 3000-bar expanded-chart
  // fetch are different needs — the big chart must not be served the small
  // one's partial result just because both are in flight.
  const k = `${exchange ?? 'auto'}:${symbol}:${tf}:${limit}`
  const existing = getFreshEntry(inflightMap, k)
  if (existing) return existing.promise

  if (exchange && !force) {
    const cached = candleCache.getCandles(exchange, symbol, tf)
    // A cache hit is only valid when it covers the FULL requested window. The
    // mini charts seed the cache with 300 bars; treating that as a hit for the
    // expanded chart's 3000-bar request made it render a partially-zoomed-out
    // chart that never fetched the rest ("zoom-out doesn't work").
    if (cached && cached.length >= limit) {
      return Promise.resolve(cached.slice(-limit))
    }
  }

  const promise = (async (): Promise<UnifiedCandle[]> => {
    // A bulk request covering this symbol is already in flight — wait for it
    // (but no longer than BULK_WAIT_MS) and read from cache instead of
    // duplicating the request. Waiting unboundedly meant a single slow symbol
    // inside the 9-symbol grid bulk blocked every chart's initial paint
    // (the bulk only resolves when ALL symbols are ready).
    // NOTE: symbolInflight is keyed WITHOUT the limit suffix (see
    // inflightKey) — the registry is per-symbol, not per-window.
    const pendingBulk = getFreshEntry(symbolInflight, inflightKey(symbol, tf, undefined, exchange))
    if (pendingBulk) {
      const bulkDone = await Promise.race([
        pendingBulk.promise.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), BULK_WAIT_MS)),
      ])
      if (bulkDone && exchange) {
        const cached = candleCache.getCandles(exchange, symbol, tf)
        if (cached && cached.length >= limit) return cached.slice(-limit)
      }
    }

    // NOTE: HTTP errors (5xx, 429, timeout) REJECT — the caller decides how
    // to retry. Only a genuine 200-empty response resolves to [] (end of
    // history). Swallowing errors here is what turned a transient server
    // hiccup into a permanent "No data" chart until page reload.
    const res = await api.get(`/coins/${symbol}/candles`, { params: { tf, limit, exchange, compact: 1 } })
    const data = normalizeCandlesResponse(res.data, symbol, tf, exchange)
    if (data.length) {
      const ex: Exchange = (data[0]?.exchange as Exchange) || (exchange as Exchange)
      if (ex) {
        candleCache.setCandles(ex, symbol, tf, data)
        // Slice to the requested window: the cache may hold MORE than this
        // call asked for (e.g. a 3000-bar fetch filled it and a concurrent
        // 300-bar request reuses it) — the caller must get its limit, not
        // the whole cache.
        return (candleCache.getCandles(ex, symbol, tf) || data).slice(-limit)
      }
      return data.slice(-limit)
    }
    return []
  })().finally(() => {
    if (inflightMap.get(k)?.promise === promise) inflightMap.delete(k)
  })

  inflightMap.set(k, freshEntry(promise))
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
  const existing = getFreshEntry(inflightMap, k)
  if (existing) return existing.promise

  // Bug 4: do NOT swallow errors — let the caller distinguish
  // "empty response" (valid, increment emptyCount) from "server error" (don't block future retries)
  const promise = api.get(`/coins/${symbol}/candles`, { params: { tf, limit, before, exchange, compact: 1 } })
    .then(res => normalizeCandlesResponse(res.data, symbol, tf, exchange))
    .catch(err => {
      const error = new Error(err?.message || 'fetch failed') as Error & { isNetworkError?: boolean }
      error.isNetworkError = true
      throw error
    })
    .finally(() => {
      if (inflightMap.get(k)?.promise === promise) inflightMap.delete(k)
    })

  inflightMap.set(k, freshEntry(promise))
  return promise
}

export function prefetchHistory(symbol: string, tf: string, exchange?: Exchange): void {
  getOrFetchHistory(symbol, tf, PREFETCH_LIMIT, exchange).catch(() => {})
}
