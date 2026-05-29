import type { ExchangeAdapter } from '../exchanges/types.js'
import { setCachedCandlesFromRest, getCachedCandles } from './candle-cache.js'
import { getTickers } from '../aggregator/index.js'

export const PRELOAD_TFS = ['5m', '15m', '1h'] as const
export const INITIAL_CANDLES_TF = '5m'
const TOP_SYMBOLS_COUNT = 100
const P1_CONCURRENCY = 10
const RATE_LIMIT_MS = 50
const PERIODIC_REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes

let preloaded = false
let preloadStats = { symbols: 0, timeframes: 0, candles: 0, startTime: 0 }

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
    const promises = batch.map(async (symbol) => {
      for (const tf of PRELOAD_TFS) {
        try {
          // Try the first adapter (typically spot)
          const adapter = adapters[0]
          let candles = await adapter.fetchCandles(symbol, tf, 1500)

          // On empty, try alternate adapter
          if (candles.length === 0) {
            const alt = getAlternateAdapter(adapter, adapters)
            if (alt) {
              candles = await alt.fetchCandles(symbol, tf, 1500)
            }
          }

          if (candles.length > 0) {
            setCachedCandlesFromRest(symbol, tf, candles)
            preloadStats.candles += candles.length
            preloadStats.timeframes++
          }
        } catch (err) {
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
  candleManager: { subscribeCandle: (symbol: string, tf: string) => void }
): void {
  const wsTfs = ['5m', '1m']
  for (const symbol of topSymbols) {
    for (const tf of wsTfs) {
      try {
        candleManager.subscribeCandle(symbol, tf)
      } catch (err) {
        console.warn(`[Preload] WS subscribe failed for ${symbol}:${tf}`, err)
      }
    }
  }
  console.log(`[Preload] WS subscriptions set up for ${topSymbols.length} symbols on 5m/1m`)
}

function periodicRefresh(
  topSymbols: string[],
  adapters: ExchangeAdapter[]
): void {
  const refreshTfs = ['5m', '1m', '15m']

  async function doRefresh() {
    console.log('[Preload] Periodic refresh: re-fetching 5m/1m/15m for top symbols')
    for (let i = 0; i < topSymbols.length; i += P1_CONCURRENCY) {
      const batch = topSymbols.slice(i, i + P1_CONCURRENCY)
      const promises = batch.map(async (symbol) => {
        for (const tf of refreshTfs) {
          try {
            const adapter = adapters[0]
            let candles = await adapter.fetchCandles(symbol, tf, 1500)
            if (candles.length === 0) {
              const alt = getAlternateAdapter(adapter, adapters)
              if (alt) candles = await alt.fetchCandles(symbol, tf, 1500)
            }
            if (candles.length > 0) {
              setCachedCandlesFromRest(symbol, tf, candles)
            }
          } catch {}
          await sleep(RATE_LIMIT_MS)
        }
      })
      await Promise.all(promises)
    }
    console.log('[Preload] Periodic refresh complete')
    setTimeout(doRefresh, PERIODIC_REFRESH_INTERVAL)
  }

  setTimeout(doRefresh, PERIODIC_REFRESH_INTERVAL)
}

export async function startPreload(
  adapters: ExchangeAdapter[],
  candleManager: { subscribeCandle: (symbol: string, tf: string) => void }
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
}

export function isPreloaded(): boolean {
  return preloaded
}

export function getPreloadStats() {
  return { ...preloadStats }
}
