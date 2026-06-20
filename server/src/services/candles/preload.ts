import type { ExchangeAdapter } from '../exchanges/types.js'
import { setCachedCandlesFromRest, getCachedCandles } from './candle-cache.js'
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

function getAlternateAdapter(
  current: ExchangeAdapter,
  adapters: ExchangeAdapter[]
): ExchangeAdapter | null {
  // Spot <-> Futures swap
  const targetType = current.type === 'spot' ? 'futures' : 'spot'
  return adapters.find(a => a.type === targetType) || null
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
          let candles = await adapter.fetchCandles(symbol, tf, cfg.candles)

          if (candles.length === 0) {
            const alt = getAlternateAdapter(adapter, adapters)
            if (alt) {
              candles = await alt.fetchCandles(symbol, tf, cfg.candles)
            }
          }

          if (candles.length > 0) {
            const exchange = getTicker(symbol)?.exchange || candles[0]?.exchange || adapter.exchange
            setCachedCandlesFromRest(symbol, tf, candles, exchange)
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

function setupWsSubscriptions(
  topSymbols: string[],
  candleManager: { subscribeCandle: (exchange: string, symbol: string, tf: string) => void }
): void {
  for (const symbol of topSymbols) {
    // Use the same exchange the client will use (ticker's exchange) so the
    // subscription key matches and the ref-count is shared, not duplicated.
    const exchange = getTicker(symbol)?.exchange
    if (!exchange) continue
    for (const tf of WS_TFS) {
      try {
        candleManager.subscribeCandle(exchange, symbol, tf)
        preloadStats.wsSubscriptions++
      } catch (err) {
        console.warn(`[Preload] WS subscribe failed for ${exchange}:${symbol}:${tf}`, err)
      }
    }
  }
  console.log(`[Preload] WS subscriptions set up for ${topSymbols.length} symbols on ${WS_TFS.join('/')}`)
}

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
            let candles = await adapter.fetchCandles(symbol, tf, limit)
            if (candles.length === 0) {
              const alt = getAlternateAdapter(adapter, adapters)
              if (alt) candles = await alt.fetchCandles(symbol, tf, limit)
            }
            if (candles.length > 0) {
              const exchange = getTicker(symbol)?.exchange || candles[0]?.exchange || adapter.exchange
              setCachedCandlesFromRest(symbol, tf, candles, exchange)
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
  candleManager: { subscribeCandle: (exchange: string, symbol: string, tf: string) => void }
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
  setupWsSubscriptions(topSymbols, candleManager)
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
      ws: [...WS_TFS],
      refresh: [...REFRESH_TFS],
      topSymbols: TOP_SYMBOLS_COUNT,
      periodicRefreshIntervalMs: PERIODIC_REFRESH_INTERVAL,
    },
  }
}
