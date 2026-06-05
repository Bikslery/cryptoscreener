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

const CHUNK_PREFIX = 'hist:'
const LOCK_PREFIX = 'lock:'

const inflightChunks = new Map<string, Promise<UnifiedCandle[]>>()

const memChunks = new Map<string, UnifiedCandle[]>()
const MAX_MEM_CHUNKS = 500

function chunkStartMs(timeMs: number, tfMs: number): number {
  return Math.floor(timeMs / (CHUNK_SIZE * tfMs)) * CHUNK_SIZE * tfMs
}

function chunkKeysFor(symbol: string, tf: string, beforeMs: number, limit: number): { key: string; csMs: number }[] {
  const tfMs = TF_MS[tf]
  if (!tfMs) return []
  const keys: { key: string; csMs: number }[] = []
  let cursor = beforeMs
  const numChunks = Math.ceil(limit / CHUNK_SIZE)
  for (let i = 0; i < numChunks; i++) {
    const cs = chunkStartMs(cursor, tfMs)
    keys.push({ key: `${CHUNK_PREFIX}${symbol}:${tf}:${cs}`, csMs: cs })
    cursor = cs - 1
    if (cursor <= 0) break
  }
  return keys
}

function compactCandle(c: UnifiedCandle): [number, number, number, number, number, number] {
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
        const tuples = JSON.parse(raw as string) as [number, number, number, number, number, number][]
        return tuples.map(([t, o, h, l, c, v]) => expandCandle(t, o, h, l, c, v, symbol, exchange, tf))
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
    const tuples = candles.map(compactCandle)
    await redis.set(key, JSON.stringify(tuples))
  } catch {}
}

function readChunkFromMem(key: string, symbol: string, exchange: Exchange, tf: string): UnifiedCandle[] | null {
  const arr = memChunks.get(key)
  if (!arr) return null
  return arr.map(c => ({ ...c, symbol, exchange, timeframe: tf }))
}

function writeChunkToMem(key: string, candles: UnifiedCandle[]): void {
  memChunks.set(key, candles)
  if (memChunks.size > MAX_MEM_CHUNKS) {
    const first = memChunks.keys().next().value
    if (first !== undefined) memChunks.delete(first)
  }
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
    const mem = memChunks.get(key)
    if (mem) return mem.map(c => ({ ...c, symbol, exchange, timeframe: tf }))
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
    console.warn(`[History] Rate budget exhausted for IP ${ipIndex}, skipping chunk`)
    return []
  }

  addWeightToIp(ipIndex, 5)

  try {
    const candles = await fetchCandlesSeamless(symbol, tf, CHUNK_SIZE, exchange, chunkStartMs, chunkEndMs, { dispatcher })
    return candles
  } catch {
    return []
  }
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
        new Promise<UnifiedCandle[]>((resolve) =>
          setTimeout(() => { console.warn(`[History] Chunk fetch timeout: ${chunkKey}`); resolve([]) }, 30000)
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

  const chunkInfos = chunkKeysFor(symbol, tf, beforeMs, limit)
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
    // Fetch missing chunks in parallel with seamless stitching
    const fetchPromises = misses.map(m =>
      getOrFetchChunk(m.key, symbol, tf, m.csMs, resolvedExchange),
    )
    const results = await Promise.all(fetchPromises)
    for (const candles of results) {
      allCandles.push(...candles)
    }
  }

  // Deduplicate by time — critical for stitched cross-exchange data
  const byTime = new Map<number, UnifiedCandle>()
  for (const c of allCandles) byTime.set(c.time, c)
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time)

  const filtered = sorted.filter(c => c.time * 1000 <= beforeMs)
  return filtered.slice(-limit)
}
