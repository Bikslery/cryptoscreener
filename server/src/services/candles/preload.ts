import type { ExchangeAdapter } from '../exchanges/types.js'
import type { UnifiedCandle, Exchange } from '../../types.js'
import { setCachedCandlesFromRest, getCachedCandles } from './candle-cache.js'
import { getTickers, getTicker } from '../aggregator/index.js'

// 1m включён: это рабочий таймфрейм для скальпинга, без прелоада первый
// переход на 1m всегда был холодным (REST к бирже). Топ-50 символов достаточно.
export const PRELOAD_TFS = ['5m', '15m', '1h', '4h', '1m'] as const
export const INITIAL_CANDLES_TF = '5m'
// Cold symbols (anything outside the preload set) pay a direct REST round-trip
// to the exchange on first request — the deeper the preload, the fewer cold
// hits. 300 symbols × 1m/5m covers essentially every symbol a screener user
// actually opens, while staying well inside the 2400 weight/min budget
// (~825 klines at boot, ~165/min average on refresh).
const TOP_SYMBOLS_COUNT = 300
// Gentler concurrency/pace: the preload competes with LIVE chart requests for
// the exchange weight budget, and a boot-time blast (10 concurrent × 5 TFs)
// exhausted it for minutes — user-facing history fetches waited behind the
// preload (the "charts load slowly right after a restart" effect). Slower
// pace + the persistent Redis chunk cache (chunks survive restarts now) make
// the boot warm-up spread out instead of starving live traffic.
const P1_CONCURRENCY = 5
const RATE_LIMIT_MS = 100
const PERIODIC_REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes
/** Delay before the FIRST periodic refresh: boot-time preload + metrics pass
 *  already burn budget; a refresh burst in the same minute starves live
 *  chart requests. */
const PERIODIC_REFRESH_INITIAL_DELAY = 60 * 1000
/** A symbol:tf whose cached tail is newer than this is skipped by the
 *  periodic refresh — the cache is fed by WS streams while users watch, so
 *  re-fetching a fresh tail burns exchange weight for zero new data. */
const REFRESH_SKIP_FRESH_SEC = 90
const PRELOAD_MATRIX: Record<string, { symbols: number; candles: number }> = {
  '5m': { symbols: 300, candles: 1000 },
  '15m': { symbols: 150, candles: 1000 },
  '1h': { symbols: 100, candles: 1000 },
  '4h': { symbols: 75, candles: 750 },
  '1m': { symbols: 200, candles: 1000 },
}
const WS_TFS = ['5m', '1m', '1h', '4h'] as const
const REFRESH_TFS = ['5m', '1m', '15m', '1h', '4h'] as const

let preloaded = false
let preloadStats = {
  symbols: 0,
  timeframes: 0,
  candles: 0,
  startTime: 0,
  byTimeframe: {} as Record<string, { symbols: number; candles: number; failures: number }>,
  wsSubscriptions: 0,
  lastRefreshAt: 0,
  refreshCount: 0,
}

function recordPreload(tf: string, candleCount: number) {
  const stats = preloadStats.byTimeframe[tf] || { symbols: 0, candles: 0, failures: 0 }
  stats.symbols++
  stats.candles += candleCount
  preloadStats.byTimeframe[tf] = stats
  preloadStats.candles += candleCount
  preloadStats.timeframes++
}

function recordFailure(tf: string) {
  const stats = preloadStats.byTimeframe[tf] || { symbols: 0, candles: 0, failures: 0 }
  stats.failures++
  preloadStats.byTimeframe[tf] = stats
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForTickers(): Promise<void> {
  const maxWait = 15000
  const pollInterval = 500
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    const tickers = getTickers()
    if (tickers.length > 0) return
    await sleep(pollInterval)
  }
  console.warn('[Preload] Timed out waiting for tickers, proceeding anyway')
}

function getTopSymbols(limit: number): string[] {
  const tickers = getTickers()
  return tickers
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, limit)
    .map(t => t.symbol)
}

/**
 * Fetch candles for a symbol, preferring the exchange the UI actually labels
 * for this symbol (getTicker().exchange — e.g. binance-futures for top
 * symbols), then falling back to the other adapters in priority order.
 *
 * Candles are ALWAYS cached under the ACTUAL source exchange key — never
 * under the target key with data from another exchange. (Previously the
 * preload fetched everything from adapters[0]=BinanceSpot and stored it
 * under getTicker().exchange, which for top symbols is binance-futures — so
 * SPOT candles were served as the "futures" history, and failed fetches left
 * stale gapped data behind that the route served forever.)
 */
async function fetchCandlesFor(
  symbol: string,
  tf: string,
  limit: number,
  adapters: ExchangeAdapter[],
): Promise<{ candles: UnifiedCandle[]; source: Exchange }> {
  const target = getTicker(symbol)?.exchange || 'binance-futures'
  const ordered = [
    ...adapters.filter(a => a.exchange === target),
    ...adapters.filter(a => a.exchange !== target),
  ]
  for (const adapter of ordered) {
    try {
      const candles = await adapter.fetchCandles(symbol, tf, limit)
      if (candles.length > 0) {
        return { candles, source: adapter.exchange }
      }
    } catch {
      // Adapter failed (throttle/geo-block/network) — try the next one.
    }
  }
  return { candles: [], source: target }
}

async function phase1(
  topSymbols: string[],
  adapters: ExchangeAdapter[]
): Promise<void> {
  console.log(`[Preload] Phase 1: loading candles for top ${topSymbols.length} symbols`)

  for (let i = 0; i < topSymbols.length; i += P1_CONCURRENCY) {
    const batch = topSymbols.slice(i, i + P1_CONCURRENCY)
    const adapter = adapters[0]
    const limiter = adapter.getRateLimiter?.()
    if (limiter?.isOverThreshold()) {
      console.warn(`[Preload] Weight at ${limiter.getWeight()}/${limiter.getLimit()}, pausing batch for 2s`)
      await sleep(2000)
    }
    const promises = batch.map(async (symbol) => {
      for (const tf of PRELOAD_TFS) {
        const cfg = PRELOAD_MATRIX[tf]
        if (i + batch.indexOf(symbol) >= cfg.symbols) continue
        try {
          const { candles, source } = await fetchCandlesFor(symbol, tf, cfg.candles, adapters)
          if (candles.length > 0) {
            // Cache under the ACTUAL source exchange so the key's data always
            // matches its label (spot data must not live in a futures key).
            setCachedCandlesFromRest(symbol, tf, candles, source)
            recordPreload(tf, candles.length)
          } else {
            recordFailure(tf)
          }
        } catch (err) {
          recordFailure(tf)
          console.warn(`[Preload] Failed to fetch ${symbol}:${tf}`, err)
        }
        await sleep(RATE_LIMIT_MS)
      }
    })
    await Promise.all(promises)
    preloadStats.symbols = Math.min(i + P1_CONCURRENCY, topSymbols.length)
  }
}

// NOTE: preload deliberately does NOT subscribe candle WS streams. Each
// subscription starts the exchange's REST candle fallback (the futures WS is
// geo-blocked here), and with ~400 preloaded streams polling every 1.5s that
// burns ~9k weight/min against the 2400/min budget — instant 429s and the
// rate-limiter deadlock that froze realtime candles. The candle cache is kept
// warm by phase1 + periodicRefresh (REST), and clients subscribe the streams
// they actually view, so the fallback only covers on-screen demand.

let periodicRefreshTimer: ReturnType<typeof setTimeout> | null = null

function periodicRefresh(
  topSymbols: string[],
  adapters: ExchangeAdapter[]
): void {
  async function doRefresh() {
    console.log(`[Preload] Periodic refresh: re-fetching ${REFRESH_TFS.join('/')} for top symbols`)
    for (let i = 0; i < topSymbols.length; i += P1_CONCURRENCY) {
      const batch = topSymbols.slice(i, i + P1_CONCURRENCY)
      const adapter = adapters[0]
      const limiter = adapter.getRateLimiter?.()
      if (limiter?.isOverThreshold()) {
        console.warn(`[Preload] Weight at ${limiter.getWeight()}/${limiter.getLimit()}, pausing refresh batch for 2s`)
        await sleep(2000)
      }
      const promises = batch.map(async (symbol) => {
        for (const tf of REFRESH_TFS) {
          // Only refresh timeframes this symbol actually preloaded — keeps the
          // periodic burst proportional to the (now larger) preload matrix
          // instead of multiplying every symbol by every timeframe.
          if (i + batch.indexOf(symbol) >= (PRELOAD_MATRIX[tf]?.symbols ?? 0)) continue
          // Skip tails that are already fresh (WS-fed or just refreshed) —
          // the refresh's only job is healing stale entries, and skipping
          // them cuts the periodic weight cost dramatically.
          const cached = getCachedCandles(symbol, tf, getTicker(symbol)?.exchange)
          const last = cached && cached.length > 0 ? cached[cached.length - 1] : null
          if (last && Date.now() / 1000 - last.time < REFRESH_SKIP_FRESH_SEC) continue
          try {
            const limit = PRELOAD_MATRIX[tf]?.candles || 1000
            const { candles, source } = await fetchCandlesFor(symbol, tf, limit, adapters)
            if (candles.length > 0) {
              setCachedCandlesFromRest(symbol, tf, candles, source)
            }
          } catch {}
          await sleep(RATE_LIMIT_MS)
        }
      })
      await Promise.all(promises)
    }
    preloadStats.lastRefreshAt = Date.now()
    preloadStats.refreshCount++
    console.log('[Preload] Periodic refresh complete')
    periodicRefreshTimer = setTimeout(doRefresh, PERIODIC_REFRESH_INTERVAL)
  }

  // First refresh after a startup grace period so it doesn't collide with
  // the boot-time preload burst and the metrics pass.
  periodicRefreshTimer = setTimeout(doRefresh, PERIODIC_REFRESH_INITIAL_DELAY)
}

export async function startPreload(
  adapters: ExchangeAdapter[],
  _candleManager?: { subscribeCandle: (exchange: string, symbol: string, tf: string) => void }
): Promise<void> {
  preloadStats.startTime = Date.now()
  console.log('[Preload] Starting...')

  await waitForTickers()

  const topSymbols = getTopSymbols(TOP_SYMBOLS_COUNT)
  if (topSymbols.length === 0) {
    console.warn('[Preload] No symbols found, skipping preload')
    return
  }

  await phase1(topSymbols, adapters)
  periodicRefresh(topSymbols, adapters)

  preloaded = true
  const elapsed = ((Date.now() - preloadStats.startTime) / 1000).toFixed(1)
  console.log(`[Preload] Complete in ${elapsed}s - ${preloadStats.symbols} symbols, ${preloadStats.timeframes} timeframes, ${preloadStats.candles} candles cached`)
  console.log(`[Preload] By timeframe: ${Object.entries(preloadStats.byTimeframe).map(([tf, s]) => `${tf}=${s.symbols}/${s.candles}`).join(', ')}`)
}

export function isPreloaded(): boolean {
  return preloaded
}

export function getPreloadStats() {
  return {
    ...preloadStats,
    byTimeframe: { ...preloadStats.byTimeframe },
    preloaded,
    configured: {
      preload: PRELOAD_MATRIX,
      // Preload deliberately does not subscribe candle WS streams (see note
      // above) — clients subscribe what they view, so the REST fallback stays
      // demand-driven and within the Binance weight budget.
      ws: [] as string[],
      refresh: [...REFRESH_TFS],
      topSymbols: TOP_SYMBOLS_COUNT,
      periodicRefreshIntervalMs: PERIODIC_REFRESH_INTERVAL,
    },
  }
}
