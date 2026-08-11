import type { ExchangeAdapter } from '../exchanges/types.js'
import type { UnifiedCandle, Exchange } from '../../types.js'
import { setCachedCandlesFromRest } from './candle-cache.js'
import { getTickers, getTicker } from '../aggregator/index.js'

// 1m включён: это рабочий таймфрейм для скальпинга, без прелоада первый
// переход на 1m всегда был холодным (REST к бирже). Топ-50 символов достаточно.
export const PRELOAD_TFS = ['5m', '15m', '1h', '4h', '1m'] as const
export const INITIAL_CANDLES_TF = '5m'
const TOP_SYMBOLS_COUNT = 100
const P1_CONCURRENCY = 10
const RATE_LIMIT_MS = 50
const PERIODIC_REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes
const PRELOAD_MATRIX: Record<string, { symbols: number; candles: number }> = {
  '5m': { symbols: 100, candles: 1000 },
  '15m': { symbols: 100, candles: 1000 },
  '1h': { symbols: 100, candles: 1000 },
  '4h': { symbols: 75, candles: 750 },
  '1m': { symbols: 50, candles: 1000 },
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

  periodicRefreshTimer = setTimeout(doRefresh, PERIODIC_REFRESH_INTERVAL)
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
