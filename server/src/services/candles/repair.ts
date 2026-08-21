import type { Exchange, UnifiedCandle } from '../../types.js'
import { getCachedCandles, setCachedCandlesFromRest, getTopCachedSymbols } from './candle-cache.js'
import { getHistory } from './history.js'
import { getTicker } from '../aggregator/index.js'
import { candleCacheHolesGauge, candleCacheRepairsTotal } from '../../metrics.js'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}
const MAX_REPAIR_WINDOW = 1000

/**
 * Cache auto-repair is DISABLED by default (scalpboard.io parity): the client
 * must render exactly what the server received, holes included. Set
 * CACHE_REPAIR_ENABLED=1 to restore the "no holes ever" watchdog + instant
 * repair (backfills real rows from the exchange over WS-skip gaps).
 */
const CACHE_REPAIR_ENABLED = process.env.CACHE_REPAIR_ENABLED === '1'

export interface CacheRepairEvent {
  ts: number
  key: string
  exchange: string
  symbol: string
  tf: string
  holesFound: number
  periodsMissing: number
  filledReal: number
  remained: number
  durationMs: number
}

const repairState = {
  cycles: 0,
  holesFoundTotal: 0,
  repairsDoneTotal: 0,
  events: [] as CacheRepairEvent[],
}
const MAX_EVENTS = 100
const inflight = new Set<string>()

export function getCacheRepairStats() {
  return {
    cycles: repairState.cycles,
    holesFoundTotal: repairState.holesFoundTotal,
    repairsDoneTotal: repairState.repairsDoneTotal,
    events: repairState.events.slice(-MAX_EVENTS),
  }
}

function holesIn(candles: UnifiedCandle[], tfSec: number): { from: number; to: number }[] {
  const holes: { from: number; to: number }[] = []
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].time - candles[i - 1].time
    if (diff > tfSec * 1.5) {
      holes.push({ from: candles[i - 1].time + tfSec, to: candles[i].time - tfSec })
    }
  }
  return holes
}

/**
 * Find every hole in the symbol's cached window and backfill those windows
 * from real exchange history (getHistory → self-healing chunks → exchange).
 * The synthetic flat candles left by cache writes / fillGaps are replaced by
 * authoritative rows. Deduplicated in-flight per (exchange,symbol,tf); no-op
 * and null when the cache has no holes.
 *
 * Bounded: at most 8 holes per pass (a pathological multi-day gap crawls
 * across consecutive cycles instead of hammering the exchange once).
 */
export async function repairCacheWindow(
  symbol: string,
  tf: string,
  exchange?: Exchange,
): Promise<CacheRepairEvent | null> {
  if (!CACHE_REPAIR_ENABLED) return null
  const tfSec = TF_SECONDS[tf]
  if (!tfSec) return null
  const cached = getCachedCandles(symbol, tf, exchange)
  if (!cached || cached.length < 2) return null
  const holes = holesIn(cached, tfSec)
  if (holes.length === 0) return null

  const key = `${exchange ?? 'auto'}:${symbol}:${tf}`
  if (inflight.has(key)) return null
  inflight.add(key)
  const startedAt = Date.now()
  try {
    const bounded = holes.slice(0, 8)
    let filledReal = 0
    let periodsMissing = 0
    const fetched: UnifiedCandle[] = []
    for (const h of bounded) {
      periodsMissing += Math.round((h.to - h.from) / tfSec) + 1
      const before = h.to + tfSec
      const limit = Math.min(Math.round((h.to - h.from) / tfSec) + 2, MAX_REPAIR_WINDOW)
      try {
        const real = await getHistory(symbol, tf, { before, limit, exchange, priority: 'background' })
        const inWindow = real.filter(c => c.time >= h.from && c.time <= h.to)
        filledReal += inWindow.length
        fetched.push(...inWindow)
      } catch {
        // transient failure — a later cycle retries
      }
    }
    if (fetched.length > 0) {
      const ex = exchange || getTicker(symbol)?.exchange || fetched[0]?.exchange
      setCachedCandlesFromRest(symbol, tf, fetched, ex)
      repairState.repairsDoneTotal++
      candleCacheRepairsTotal.inc()
    }
    const ev: CacheRepairEvent = {
      ts: startedAt,
      key,
      exchange: exchange || getTicker(symbol)?.exchange || 'auto',
      symbol,
      tf,
      holesFound: holes.length,
      periodsMissing,
      filledReal,
      remained: Math.max(0, periodsMissing - filledReal),
      durationMs: Date.now() - startedAt,
    }
    repairState.holesFoundTotal += holes.length
    repairState.events.push(ev)
    if (repairState.events.length > MAX_EVENTS) repairState.events.shift()
    return ev
  } finally {
    inflight.delete(key)
  }
}

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000
const WATCHDOG_TFS = ['5m', '1m', '15m', '1h', '4h'] as const
const WATCHDOG_SYMBOLS_PER_TF = 12
const WATCHDOG_MAX_REPAIRS_PER_CYCLE = 40

let watchdogTimer: ReturnType<typeof setInterval> | null = null

/**
 * Periodic guarantee: every ~5 minutes audit the recently-used cache for holes
 * and repair them from the exchange, so even a hole that slipped past the
 * ingest-time fill and the instant repair disappears before it can be served
 * to a client. Rate-limit friendly (getHistory handles the budget; bounded
 * per-cycle fan-out).
 */
export function startCacheRepairWatchdog(): void {
  if (!CACHE_REPAIR_ENABLED) {
    console.log('[CacheRepair] Disabled (CACHE_REPAIR_ENABLED unset — scalpboard parity, holes stay visible)')
    return
  }
  if (watchdogTimer) return
  runCacheRepairCycle()
  watchdogTimer = setInterval(runCacheRepairCycle, WATCHDOG_INTERVAL_MS)
  console.log('[CacheRepair] Watchdog started (every 5m)')
}

async function runCacheRepairCycle(): Promise<void> {
  repairState.cycles++
  let repairs = 0
  let holesThisCycle = 0
  for (const tf of WATCHDOG_TFS) {
    if (repairs >= WATCHDOG_MAX_REPAIRS_PER_CYCLE) break
    const symbols = getTopCachedSymbols(tf, WATCHDOG_SYMBOLS_PER_TF)
    for (const symbol of symbols) {
      if (repairs >= WATCHDOG_MAX_REPAIRS_PER_CYCLE) break
      try {
        const ev = await repairCacheWindow(symbol, tf)
        if (ev) {
          repairs++
          holesThisCycle += ev.holesFound
          console.log(`[CacheRepair] fixed ${ev.key}: holes=${ev.holesFound} filled=${ev.filledReal}/${ev.periodsMissing} (${ev.durationMs}ms)`)
        }
      } catch {
        // per-symbol errors must not abort the cycle
      }
    }
  }
  candleCacheHolesGauge.set(holesThisCycle)
}
