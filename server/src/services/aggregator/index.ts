import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { BinanceSpotAdapter } from '../exchanges/binance-spot.js'
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.js'
import type { ExchangeAdapter } from '../exchanges/types.js'
import { broadcast, broadcastToChannel } from '../../ws/hub.js'
import { updateCachedCandle, getCachedCandles } from '../candles/candle-cache.js'
import { getRedisPub, getRedisData, REDIS_ENABLED } from '../../redis.js'

export const adapters: ExchangeAdapter[] = [
  new BinanceSpotAdapter(),
  new BinanceFuturesAdapter(),
]

const tickerMap = new Map<string, UnifiedTicker>()
const EXCHANGE_PRIORITY: Record<string, number> = {
  'binance-futures': 5,
  'bybit-futures': 4,
  'okx-spot': 3,
  'binance-spot': 2,
}

function pickBestFromMap(): Map<string, UnifiedTicker> {
  const best = new Map<string, UnifiedTicker>()
  for (const t of tickerMap.values()) {
    const existing = best.get(t.symbol)
    if (!existing || EXCHANGE_PRIORITY[t.exchange] > EXCHANGE_PRIORITY[existing.exchange]) {
      best.set(t.symbol, t)
    }
  }
  return best
}

const BROADCAST_INTERVAL = 200
let lastBroadcast = 0
let loggedFirst = false
let tickerCount = 0
const metricsMap = new Map<string, { range1m: number; natr5m: number }>()

let cachedBestMap: Map<string, UnifiedTicker> | null = null
let cachedBest: UnifiedTicker[] | null = null
let lastBroadcastedTickers = new Map<string, Partial<UnifiedTicker>>()

function getBestMap(): Map<string, UnifiedTicker> {
  if (!cachedBestMap) cachedBestMap = pickBestFromMap()
  return cachedBestMap
}

function computeDelta(best: Map<string, UnifiedTicker>): UnifiedTicker[] {
  const delta: UnifiedTicker[] = []
  const seen = new Set<string>()
  for (const [symbol, t] of best) {
    seen.add(symbol)
    const prev = lastBroadcastedTickers.get(symbol)
    if (!prev || prev.price !== t.price || prev.change24h !== t.change24h || prev.quoteVolume24h !== t.quoteVolume24h) {
      delta.push(t)
    }
  }
  for (const [symbol] of lastBroadcastedTickers) {
    if (!seen.has(symbol)) delta.push({ symbol, exchange: 'binance-spot' } as UnifiedTicker)
  }
  lastBroadcastedTickers = new Map(
    Array.from(best.entries()).map(([s, t]) => [s, { symbol: s, price: t.price, change24h: t.change24h, quoteVolume24h: t.quoteVolume24h }])
  )
  return delta
}

const ROLE = process.env.ROLE || 'all'
const isBroadcast = ROLE === 'broadcast' || ROLE === 'all'
const isIngestion = ROLE === 'ingestion' || ROLE === 'all'

export function startAggregator() {
  for (const adapter of adapters) {
    adapter.onTicker((ticker) => {
      const m = metricsMap.get(ticker.symbol)
      if (m) {
        ticker.range1m = m.range1m
        ticker.natr5m = m.natr5m
      }
      tickerMap.set(`${ticker.symbol}:${ticker.exchange}`, ticker)
      cachedBestMap = null
      cachedBest = null
      tickerCount++
      const now = Date.now()
      if (now - lastBroadcast > BROADCAST_INTERVAL) {
        lastBroadcast = now
        const best = getBestMap()
        const arr = Array.from(best.values())

        if (isIngestion && REDIS_ENABLED) {
          try {
            const redis = getRedisPub()
            redis.publish('tickers', JSON.stringify(arr)).catch(() => {})
          } catch {}
        }

        if (isBroadcast) {
          const delta = computeDelta(best)
          if (delta.length > 0) {
            broadcast({ type: 'ticker', data: arr })
          }
        }

        if (!loggedFirst) {
          loggedFirst = true
          console.log(`[Aggregator] First broadcast: ${arr.length} coins (received ${tickerCount} ticks), top: ${arr.slice(0, 3).map(t => t.symbol).join(', ')}`)
        }
      }
    })

    adapter.onCandle((candle) => {
      updateCachedCandle(candle)
      if (isIngestion && REDIS_ENABLED) {
        try {
          const redis = getRedisPub()
          redis.publish('candles', JSON.stringify(candle)).catch(() => {})
        } catch {}
      }
      if (isBroadcast) {
        broadcastToChannel(`candle:${candle.symbol}:${candle.timeframe}`, candle)
      }
    })

    adapter.onDepth((depth) => {
      if (isIngestion && REDIS_ENABLED) {
        try {
          const redis = getRedisPub()
          redis.publish('depth', JSON.stringify(depth)).catch(() => {})
        } catch {}
      }
      if (isBroadcast) {
        broadcastToChannel(`depth:${depth.symbol}`, depth)
      }
    })

    console.log(`[Aggregator] Starting adapter: ${adapter.name} (${adapter.exchange})`)
    adapter.connect()
  }

  computeMetrics()
}

async function computeMetrics() {
  const compute = async () => {
    const best = getBestMap()
    const topCoins = Array.from(best.values())
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 200)

    const symbolsToRemove: string[] = []

    for (const coin of topCoins) {
      try {
        const cached1m = getCachedCandles(coin.symbol, '1m')
        let candles1m: UnifiedCandle[]
        if (cached1m && cached1m.length >= 2) {
          candles1m = cached1m.slice(-5)
        } else {
          candles1m = await fetchCandles(coin.symbol, '1m', 5, coin.exchange)
        }
        if (candles1m.length >= 2) {
          const highs = candles1m.map(c => c.high)
          const lows = candles1m.map(c => c.low)
          const minLow = Math.min(...lows)
          const maxHigh = Math.max(...highs)
          const range1m = minLow > 0 ? ((maxHigh - minLow) / minLow) * 100 : 0
          metricsMap.set(coin.symbol, { ...(metricsMap.get(coin.symbol) || { natr5m: 0 }), range1m })
        }

        const cached5m = getCachedCandles(coin.symbol, '5m')
        let candles5m: UnifiedCandle[]
        if (cached5m && cached5m.length >= 14) {
          candles5m = cached5m.slice(-14)
        } else {
          candles5m = await fetchCandles(coin.symbol, '5m', 14, coin.exchange)
        }
        if (candles5m.length >= 2) {
          const trs = candles5m.map((c, i) => {
            if (i === 0) return c.high - c.low
            const prevClose = candles5m[i - 1].close
            return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
          })
          const atr = trs.reduce((s, v) => s + v, 0) / trs.length
          const natr5m = coin.price > 0 ? (atr / coin.price) * 100 : 0
          metricsMap.set(coin.symbol, { ...(metricsMap.get(coin.symbol) || { range1m: 0 }), natr5m })
        }
      } catch (e) {
        console.warn(`[Metrics] Failed for ${coin.symbol}:`, e instanceof Error ? e.message : e)
      }
    }

    for (const [symbol] of metricsMap) {
      if (!best.has(symbol)) symbolsToRemove.push(symbol)
    }
    for (const s of symbolsToRemove) metricsMap.delete(s)

    console.log(`[Metrics] Updated range1m/natr5m for top ${topCoins.length} coins (cache hits preferred)`)
  }

  await compute()
  setInterval(compute, 30000)
}

export function getTickers(): UnifiedTicker[] {
  if (!cachedBest) {
    cachedBest = Array.from(getBestMap().values())
  }
  return cachedBest
}

export function getTicker(symbol: string): UnifiedTicker | undefined {
  return getBestMap().get(symbol)
}

export function setTickersFromRedis(tickers: UnifiedTicker[]) {
  for (const t of tickers) {
    tickerMap.set(`${t.symbol}:${t.exchange}`, t)
  }
  cachedBestMap = null
  cachedBest = null
}

function adaptersByPriority(): ExchangeAdapter[] {
  return [...adapters].sort((a, b) =>
    (EXCHANGE_PRIORITY[b.exchange] ?? 0) - (EXCHANGE_PRIORITY[a.exchange] ?? 0)
  )
}

export async function fetchCandles(symbol: string, tf: string, limit: number, exchange?: Exchange, startTime?: number, endTime?: number, options?: import('../exchanges/types.js').FetchCandlesOptions): Promise<UnifiedCandle[]> {
  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  // Try target first, then all others by priority
  const ordered = adaptersByPriority()
  const targetIdx = ordered.findIndex(a => a.exchange === targetExchange)
  if (targetIdx > 0) { const [t] = ordered.splice(targetIdx, 1); ordered.unshift(t) }
  if (targetIdx === -1) {
    // target not found in adapters, just try by priority
  }

  for (const adapter of ordered) {
    try {
      const candles = await adapter.fetchCandles(symbol, tf, limit, startTime, endTime, options)
      if (candles.length > 0) return candles
    } catch {
      continue
    }
  }
  return []
}

/**
 * Seamless cross-exchange history stitcher (scalpboard.io pattern).
 * Fetches candles from the primary exchange. When data runs out
 * (exchange listed the pair recently), automatically fetches older
 * data from the next-priority exchange and glues the series together.
 * Returns a single deduplicated, time-sorted candle array.
 */
export async function fetchCandlesSeamless(
  symbol: string,
  tf: string,
  limit: number,
  exchange?: Exchange,
  startTime?: number,
  endTime?: number,
  options?: import('../exchanges/types.js').FetchCandlesOptions,
): Promise<UnifiedCandle[]> {
  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  const ordered = adaptersByPriority()
  const targetIdx = ordered.findIndex(a => a.exchange === targetExchange)
  if (targetIdx > 0) { const [t] = ordered.splice(targetIdx, 1); ordered.unshift(t) }

  const allCandles: UnifiedCandle[] = []
  let remaining = limit
  let currentEnd = endTime
  let currentStart = startTime
  const triedExchanges = new Set<string>()

  for (const adapter of ordered) {
    if (remaining <= 0) break
    if (triedExchanges.has(adapter.exchange)) continue
    triedExchanges.add(adapter.exchange)

    try {
      const candles = await adapter.fetchCandles(symbol, tf, remaining, currentStart, currentEnd, options)
      if (candles.length === 0) continue

      allCandles.push(...candles)

      const earliestTime = candles[0].time
      const tfMs = TF_MS_AGGR[tf]
      if (!tfMs) break

      const requested = remaining
      remaining -= candles.length

      // Did this exchange return fewer candles than we asked for?
      // If so, data likely ends here — try next exchange for older history
      if (candles.length < requested) {
        // Keep currentEnd in MILLISECONDS (Binance API expects ms)
        currentEnd = earliestTime * 1000 - tfMs
        // Clear currentStart so next exchange can fetch as far back as it has
        currentStart = undefined
        if (currentEnd <= 0) break
      } else {
        // Got full range — no stitching needed
        break
      }
    } catch {
      continue
    }
  }

  // Deduplicate by time, keep highest-priority exchange candle for each timestamp
  const byTime = new Map<number, UnifiedCandle>()
  for (const c of allCandles) byTime.set(c.time, c)
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time)
  return sorted.slice(-limit)
}

const TF_MS_AGGR: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000,
  '1d': 86_400_000, '1w': 604_800_000,
}

export async function fetchDepth(symbol: string, limit: number, exchange?: Exchange): Promise<UnifiedDepth | null> {
  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  const adapter = adapters.find(a => a.exchange === targetExchange)
  if (!adapter) return null
  try {
    return await adapter.fetchDepth(symbol, limit)
  } catch {
    return null
  }
}
