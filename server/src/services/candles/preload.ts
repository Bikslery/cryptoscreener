import type { ExchangeAdapter } from '../exchanges/types.js'
import { getTickers, adapters as aggregatorAdapters } from '../aggregator/index.js'
import {
  setCachedCandlesFromRest,
  getCacheKeys,
} from './candle-cache.js'
import type { UnifiedCandle } from '../../types.js'

const PRELOAD_TFS = ['5m', '1m', '15m', '1h']
const TOP_SYMBOLS_COUNT = 50
const P1_CONCURRENCY = 5
const RATE_LIMIT_MS = 100
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

let phase1Done = false
let refreshTimer: ReturnType<typeof setInterval> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForTickers(): Promise<boolean> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const tickers = getTickers()
    if (tickers.length > 0) return true
    await sleep(500)
  }
  console.warn('[Preload] Timed out waiting for tickers')
  return false
}

function getAlternateAdapter(current: ExchangeAdapter): ExchangeAdapter | null {
  if (current.type === 'spot') {
    return aggregatorAdapters.find(a => a.type === 'futures') || null
  }
  return aggregatorAdapters.find(a => a.type === 'spot') || null
}

async function fetchWithFallback(
  adapter: ExchangeAdapter,
  symbol: string,
  tf: string,
  limit: number
): Promise<UnifiedCandle[]> {
  try {
    const candles = await adapter.fetchCandles(symbol, tf, limit)
    if (candles.length > 0) return candles
  } catch {}

  // Empty or error: try alternate adapter
  const alt = getAlternateAdapter(adapter)
  if (alt) {
    try {
      const candles = await alt.fetchCandles(symbol, tf, limit)
      if (candles.length > 0) return candles
    } catch {}
  }

  return []
}

async function phase1(topSymbols: string[]): Promise<void> {
  console.log(`[Preload] Phase 1: fetching ${topSymbols.length} symbols x ${PRELOAD_TFS.length} timeframes`)

  for (let i = 0; i < topSymbols.length; i += P1_CONCURRENCY) {
    const batch = topSymbols.slice(i, i + P1_CONCURRENCY)
    const promises = batch.map(async (symbol) => {
      for (const tf of PRELOAD_TFS) {
        // Pick best adapter: prefer futures for top symbols
        const adapter = aggregatorAdapters[1] || aggregatorAdapters[0]
        const candles = await fetchWithFallback(adapter, symbol, tf, 1500)
        if (candles.length > 0) {
          setCachedCandlesFromRest(symbol, tf, candles)
        }
        await sleep(RATE_LIMIT_MS)
      }
    })
    await Promise.all(promises)
    console.log(`[Preload] Phase 1 progress: ${Math.min(i + P1_CONCURRENCY, topSymbols.length)}/${topSymbols.length} symbols`)
  }
}

function setupWssubscriptions(
  topSymbols: string[],
  candleManager: { subscribeCandle: (symbol: string, tf: string) => void }
): void {
  const wsTfs = ['5m', '1m']
  for (const symbol of topSymbols) {
    for (const tf of wsTfs) {
      try {
        candleManager.subscribeCandle(symbol, tf)
      } catch {}
    }
  }
  console.log(`[Preload] WS subscriptions set for ${topSymbols.length} symbols on 5m/1m`)
}

async function periodicRefresh(topSymbols: string[]): Promise<void> {
  const refreshTfs = ['5m', '1m', '15m']
  console.log(`[Preload] Periodic refresh: ${topSymbols.length} symbols`)

  for (let i = 0; i < topSymbols.length; i += P1_CONCURRENCY) {
    const batch = topSymbols.slice(i, i + P1_CONCURRENCY)
    const promises = batch.map(async (symbol) => {
      for (const tf of refreshTfs) {
        const adapter = aggregatorAdapters[1] || aggregatorAdapters[0]
        try {
          const candles = await adapter.fetchCandles(symbol, tf, 1500)
          if (candles.length > 0) {
            setCachedCandlesFromRest(symbol, tf, candles)
          }
        } catch {}
        await sleep(RATE_LIMIT_MS)
      }
    })
    await Promise.all(promises)
  }
}

export function startPreload(
  adapters: ExchangeAdapter[],
  candleManager: { subscribeCandle: (symbol: string, tf: string) => void }
): void {
  // Run async, non-blocking
  ;(async () => {
    try {
      const hasTickers = await waitForTickers()
      if (!hasTickers) return

      const tickers = getTickers()
      const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      const topSymbols = sorted.slice(0, TOP_SYMBOLS_COUNT).map(t => t.symbol)

      console.log(`[Preload] Top ${topSymbols.length} symbols: ${topSymbols.slice(0, 5).join(', ')}...`)

      await phase1(topSymbols)

      phase1Done = true
      console.log(`[Preload] Phase 1 complete. Cached keys: ${getCacheKeys().length}`)

      // Set permanent WS subscriptions for top-50 on 5m and 1m
      setupWssubscriptions(topSymbols, candleManager)

      // Periodic refresh every 5 minutes
      refreshTimer = setInterval(() => {
        periodicRefresh(topSymbols).catch(err => {
          console.error('[Preload] Periodic refresh error:', err)
        })
      }, REFRESH_INTERVAL_MS)
    } catch (err) {
      console.error('[Preload] Fatal error:', err)
    }
  })()
}

export function isPreloaded(): boolean {
  return phase1Done
}

export function getPreloadStats(): { phase1Done: boolean; cachedKeys: number } {
  return {
    phase1Done,
    cachedKeys: getCacheKeys().length,
  }
}

export { PRELOAD_TFS }
