import { fetchCandles, fetchCandlesSeamless, getTicker } from '../aggregator/index.js'
import { getRedisData, REDIS_ENABLED } from '../../redis.js'
import { pickDispatcher, addWeightToIp, getIpCount } from '../exchanges/proxy.js'
import { acquireBudget } from '../exchanges/rate-limiter.js'
import type { Exchange, UnifiedCandle } from '../../types.js'

const CHUNK_SIZE = 1000

const TF_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
}

export const HISTORY_CACHE_VERSION = 2
const CHUNK_PREFIX = `hist:v${HISTORY_CACHE_VERSION}:`
const LOCK_PREFIX = 'lock:'

const inflightChunks = new Map<string, Promise<UnifiedCandle[]>>()

// Chunk cache lifetimes. Historical (closed) chunks are immutable, but a
// chunk written during a throttled/geo-blocked period may be PARTIAL — and
// serving that forever is what produced permanent holes in history ("empty
// spots" during sharp moves). Redis keys get an expiry so poisoned chunks
// self-heal, and memory chunks are revalidated after MEM_CHUNK_TTL_MS so a
// bad fetch is retried instead of being served indefinitely.
const REDIS_CHUNK_TTL_FULL_S = 30 * 24 * 3600 // closed immutable chunk
const REDIS_CHUNK_TTL_PARTIAL_S = 10 * 60 // partial chunk (short-lived: retry soon)
const MEM_CHUNK_TTL_MS = 5 * 60 * 1000

interface MemChunk {
  candles: UnifiedCandle[]
  ts: number
}

type CompactCandle = [number, number, number, number, number, number]

interface StoredHistoryChunkV2 {
  version: typeof HISTORY_CACHE_VERSION
  writtenAt: number
  complete: boolean
  rowCount: number
  minTime: number
  maxTime: number
  sources: Exchange[]
  rows: CompactCandle[]
}

const memChunks = new Map<string, MemChunk>()
const MAX_MEM_CHUNKS = 500

// Short-TTL response cache: repeated identical requests (the 9-chart grid
// re-polls the same symbols, page flips hit the same keys) skip the chunk
// planning + Redis read + merge/dedup pass entirely. 10s TTL is long enough
// to absorb grid bursts, short enough that responses never go visibly stale.
const RESPONSE_CACHE_TTL_MS = 10_000
const MAX_RESPONSE_CACHE_ENTRIES = 1000
const responseCache = new Map<string, { candles: UnifiedCandle[]; ts: number }>()

function getCachedResponse(key: string): UnifiedCandle[] | null {
  const entry = responseCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key)
    return null
  }
  return entry.candles
}

function setCachedResponse(key: string, candles: UnifiedCandle[]): void {
  if (responseCache.size >= MAX_RESPONSE_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value
    if (oldest !== undefined) responseCache.delete(oldest)
  }
  responseCache.set(key, { candles, ts: Date.now() })
}

function chunkStartMs(timeMs: number, tfMs: number): number {
  return Math.floor(timeMs / (CHUNK_SIZE * tfMs)) * CHUNK_SIZE * tfMs
}

function chunkKeysFor(exchange: Exchange, symbol: string, tf: string, beforeMs: number, limit: number): { key: string; csMs: number }[] {
  const tfMs = TF_MS[tf]
  if (!tfMs) return []
  const keys: { key: string; csMs: number }[] = []
  let cursor = beforeMs
  // The most-recent chunk is usually PARTIAL (it only holds candles that
  // elapsed since the chunk-grid boundary — for 5m that can be ~250 rows of
  // 1000). Naive ceil(limit / CHUNK_SIZE) planning under-plans depth: a
  // limit=1000 5m request would get ~250 bars and never go deeper. Plan
  // against expected rows per chunk (partial first chunk, full ones beyond)
  // so the request reliably covers the full requested depth.
  const maxChunks = Math.ceil(limit / CHUNK_SIZE) + 1
  let remaining = limit
  let prevCs: number | undefined
  while (remaining > 0 && keys.length < maxChunks) {
    const cs = chunkStartMs(cursor, tfMs)
    if (cs !== prevCs) {
      keys.push({ key: `${CHUNK_PREFIX}${exchange}:${symbol}:${tf}:${cs}`, csMs: cs })
    } else {
      break
    }
    prevCs = cs
    const rowsInChunk =
      cs + CHUNK_SIZE * tfMs > beforeMs
        ? Math.min(CHUNK_SIZE, Math.max(1, Math.floor((beforeMs - cs) / tfMs)) + 1)
        : CHUNK_SIZE
    remaining -= rowsInChunk
    cursor = cs - 1
    if (cursor <= 0) break
  }
  return keys
}

function compactCandle(c: UnifiedCandle): CompactCandle {
  return [c.time, c.open, c.high, c.low, c.close, c.volume]
}

function expandCandle(t: number, o: number, h: number, l: number, c: number, v: number, symbol: string, exchange: Exchange, tf: string): UnifiedCandle {
  return { symbol, exchange, timeframe: tf, time: t, open: o, high: h, low: l, close: c, volume: v }
}

async function readChunksFromRedis(keys: string[], symbol: string, exchange: Exchange, tf: string): Promise<(UnifiedCandle[] | null)[]> {
  if (!REDIS_ENABLED || keys.length === 0) return keys.map(() => null)
  try {
    const redis = getRedisData()
    const raws = await redis.mget(...keys)
    return raws.map(raw => {
      if (!raw) return null
      try {
        const stored = JSON.parse(raw as string) as StoredHistoryChunkV2
        if (
          stored.version !== HISTORY_CACHE_VERSION ||
          !Array.isArray(stored.rows) ||
          stored.rowCount !== stored.rows.length
        ) return null
        return stored.rows.map(([t, o, h, l, c, v]) => expandCandle(t, o, h, l, c, v, symbol, exchange, tf))
      } catch {
        return null
      }
    })
  } catch {
    return keys.map(() => null)
  }
}

async function writeChunkToRedis(key: string, candles: UnifiedCandle[]): Promise<void> {
  if (!REDIS_ENABLED || candles.length === 0) return
  try {
    const redis = getRedisData()
    const rows = candles.map(compactCandle)
    const stored: StoredHistoryChunkV2 = {
      version: HISTORY_CACHE_VERSION,
      writtenAt: Date.now(),
      complete: candles.length >= CHUNK_SIZE,
      rowCount: rows.length,
      minTime: candles[0].time,
      maxTime: candles[candles.length - 1].time,
      sources: Array.from(new Set(candles.map(c => c.exchange))),
      rows,
    }
    const ttl = candles.length >= CHUNK_SIZE ? REDIS_CHUNK_TTL_FULL_S : REDIS_CHUNK_TTL_PARTIAL_S
    await redis.set(key, JSON.stringify(stored), 'EX', ttl)
  } catch {}
}

function readChunkFromMem(key: string, symbol: string, exchange: Exchange, tf: string): UnifiedCandle[] | null {
  const entry = memChunks.get(key)
  if (!entry) return null
  // Stale mem chunk (e.g. written during a throttled period with partial
  // data) — treat as a miss so the fetch is retried and the hole heals.
  if (Date.now() - entry.ts > MEM_CHUNK_TTL_MS) return null
  return entry.candles.map(c => ({ ...c, symbol, exchange, timeframe: tf }))
}

function writeChunkToMem(key: string, candles: UnifiedCandle[]): void {
  memChunks.set(key, { candles, ts: Date.now() })
  if (memChunks.size > MAX_MEM_CHUNKS) {
    const first = memChunks.keys().next().value
    if (first !== undefined) memChunks.delete(first)
  }
}

/**
 * Kept as a compatibility hook for older deployments. Cache invalidation is
 * namespace-based now: a schema change increments HISTORY_CACHE_VERSION.
 * Legacy keys already carry TTLs and expire naturally, so startup never scans
 * or deletes warm history based on the candles' market timestamp.
 */
export async function flushHistoryChunkCache(): Promise<void> {
  return
}

async function acquireLock(lockKey: string, ttlMs: number = 5000): Promise<boolean> {
  if (!REDIS_ENABLED) return true
  try {
    const redis = getRedisData()
    const result = await redis.set(lockKey, '1', 'PX', ttlMs, 'NX')
    return result === 'OK'
  } catch {
    return true
  }
}

async function releaseLock(lockKey: string): Promise<void> {
  if (!REDIS_ENABLED) return
  try {
    const redis = getRedisData()
    await redis.del(lockKey)
  } catch {}
}

async function waitForChunk(key: string, symbol: string, exchange: Exchange, tf: string, timeoutMs: number = 2000): Promise<UnifiedCandle[] | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (REDIS_ENABLED) {
      try {
        const redis = getRedisData()
        const raw = await redis.get(key)
        if (raw) {
          try {
            const tuples = JSON.parse(raw) as [number, number, number, number, number, number][]
            return tuples.map(([t, o, h, l, c, v]) => expandCandle(t, o, h, l, c, v, symbol, exchange, tf))
          } catch {}
        }
      } catch {}
    }
    const mem = readChunkFromMem(key, symbol, exchange, tf)
    if (mem) return mem
    await new Promise(r => setTimeout(r, 50))
  }
  return null
}

/**
 * Fetch a chunk using seamless cross-exchange stitching.
 * If the primary exchange returns fewer candles than CHUNK_SIZE
 * (data ends mid-chunk because pair was listed recently),
 * automatically tries other exchanges to fill the gap.
 */
async function fetchChunkSeamless(
  symbol: string,
  tf: string,
  chunkStartMs: number,
  exchange?: Exchange,
): Promise<UnifiedCandle[]> {
  const tfMs = TF_MS[tf]
  if (!tfMs) return []
  const chunkEndMs = chunkStartMs + CHUNK_SIZE * tfMs - 1

  const { dispatcher, ipIndex } = pickDispatcher()
  const market: 'spot' | 'futures' = (exchange?.includes('futures') ? 'futures' : 'spot') as 'spot' | 'futures'

  const acquired = await acquireBudget(market, 5, ipIndex)
  if (!acquired) {
    // Transient failure, NOT end-of-history. Throw so the API layer answers
    // with an error (client retries) instead of 200 [] — an empty page is
    // indistinguishable from "history ended" and permanently stops lazy load.
    console.warn(`[History] Rate budget exhausted for IP ${ipIndex}, skipping chunk`)
    throw new Error(`[History] Rate budget exhausted for IP ${ipIndex}`)
  }

  addWeightToIp(ipIndex, 5)

  // fetchCandlesSeamless swallows adapter errors internally; anything that
  // escapes it is a genuine transient failure and must propagate (not
  // masquerade as end-of-history).
  const candles = await fetchCandlesSeamless(symbol, tf, CHUNK_SIZE, exchange, chunkStartMs, chunkEndMs, { dispatcher })
  return candles
}

function isCurrentChunk(chunkStartMs: number, tf: string): boolean {
  const tfMs = TF_MS[tf]
  if (!tfMs) return false
  const now = Date.now()
  return chunkStartMs + CHUNK_SIZE * tfMs > now
}

async function fetchAndCacheChunk(
  chunkKey: string,
  symbol: string,
  tf: string,
  chunkStartMs: number,
  exchange?: Exchange,
): Promise<UnifiedCandle[]> {
  const lockKey = `${LOCK_PREFIX}${chunkKey}`
  const lockAcquired = await acquireLock(lockKey)

  if (lockAcquired) {
    try {
      const candles = await fetchChunkSeamless(symbol, tf, chunkStartMs, exchange)
      if (candles.length > 0) {
        if (!isCurrentChunk(chunkStartMs, tf)) {
          await writeChunkToRedis(chunkKey, candles)
        }
        writeChunkToMem(chunkKey, candles)
      }
      return candles
    } finally {
      await releaseLock(lockKey)
    }
  } else {
    const result = await waitForChunk(chunkKey, symbol, exchange || 'binance-futures', tf)
    if (result) return result
    return fetchChunkSeamless(symbol, tf, chunkStartMs, exchange)
  }
}

function getOrFetchChunk(
  chunkKey: string,
  symbol: string,
  tf: string,
  chunkStartMs: number,
  exchange?: Exchange,
): Promise<UnifiedCandle[]> {
  const existing = inflightChunks.get(chunkKey)
  if (existing) return existing

  const promise = (async () => {
    try {
      // Timeout wrapper: if fetch takes > 30s, resolve with empty
      const result = await Promise.race([
        fetchAndCacheChunk(chunkKey, symbol, tf, chunkStartMs, exchange),
        new Promise<UnifiedCandle[]>((_resolve, reject) =>
          setTimeout(() => { console.warn(`[History] Chunk fetch timeout: ${chunkKey}`); reject(new Error(`[History] Chunk fetch timeout: ${chunkKey}`)) }, 30000)
        ),
      ])
      return result
    } finally {
      inflightChunks.delete(chunkKey)
    }
  })()

  inflightChunks.set(chunkKey, promise)
  return promise
}

export interface HistoryOptions {
  before?: number
  limit?: number
  exchange?: Exchange
}

/**
 * Get candle history with seamless cross-exchange stitching.
 *
 * Algorithm (scalpboard.io pattern):
 * 1. Determine which time-chunks are needed
 * 2. Check Redis + memory cache for each chunk
 * 3. For missing chunks, fetch via fetchChunkSeamless which:
 *    - Tries primary exchange first
 *    - If data ends mid-chunk, tries next-priority exchange
 *    - Glues the results together, deduplicates by time
 * 4. Merge all chunks, dedup by time, sort, slice to limit
 */
export async function getHistory(
  symbol: string,
  tf: string,
  options: HistoryOptions = {},
): Promise<UnifiedCandle[]> {
  const { before, limit = 1000, exchange } = options
  const tfMs = TF_MS[tf]
  if (!tfMs) return []

  const resolvedExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  const beforeMs = before ? before * 1000 - 1 : Date.now()

  // Response-cache fast path (10s TTL): repeated grid/bulk polls of the same
  // window skip chunk planning, Redis reads and merge/sort entirely.
  const responseKey = `${resolvedExchange}:${symbol}:${tf}:${limit}:${before ?? 'tail'}`
  const cachedResponse = getCachedResponse(responseKey)
  if (cachedResponse) return cachedResponse

  const chunkInfos = chunkKeysFor(resolvedExchange, symbol, tf, beforeMs, limit)
  if (chunkInfos.length === 0) return []

  const keys = chunkInfos.map(ci => ci.key)

  const redisResults = await readChunksFromRedis(keys, symbol, resolvedExchange, tf)
  const allCandles: UnifiedCandle[] = []
  const misses: { key: string; csMs: number; idx: number }[] = []

  for (let i = 0; i < keys.length; i++) {
    const redisData = redisResults[i]
    if (redisData) {
      allCandles.push(...redisData)
    } else {
      const memData = readChunkFromMem(keys[i], symbol, resolvedExchange, tf)
      if (memData) {
        allCandles.push(...memData)
      } else {
        misses.push({ key: keys[i], csMs: chunkInfos[i].csMs, idx: i })
      }
    }
  }

  if (misses.length > 0) {
    // Fetch missing chunks with a small worker pool (was: strictly sequential).
    // Each chunk is already budget-gated via acquireBudget(weight 5) + the
    // inflightChunks dedup, so 2 in flight keeps the exchange happy while
    // halving the latency of multi-chunk requests (e.g. the 3000-candle
    // expanded chart = 3-4 chunks). A parallel blast of 3+ per request across
    // many symbols is what trips Binance rate limits — hence the pool cap.
    const POOL_SIZE = 2
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < misses.length) {
        const m = misses[cursor++]
        try {
          const chunk = await getOrFetchChunk(m.key, symbol, tf, m.csMs, resolvedExchange)
          allCandles.push(...chunk)
        } catch (e) {
          throw new Error(
            `[History] chunk fetch failed transiently (${resolvedExchange} ${symbol} ${tf} ${m.key}): ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL_SIZE, misses.length) }, () => worker()))
  }

  // Deduplicate by time — critical for stitched cross-exchange data
  const byTime = new Map<number, UnifiedCandle>()
  for (const c of allCandles) byTime.set(c.time, c)
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time)

  const filtered = sorted.filter(c => c.time * 1000 <= beforeMs)
  const result = filtered.slice(-limit)
  if (result.length > 0) setCachedResponse(responseKey, result)
  return result
}
