import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { BinanceSpotAdapter } from '../exchanges/binance-spot.js'
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.js'
// import { BybitFuturesAdapter } from '../exchanges/bybit-futures.js'
// import { OkxSpotAdapter } from '../exchanges/okx-spot.js'
import type { ExchangeAdapter } from '../exchanges/types.js'
import { broadcast } from '../../ws/hub.js'

export const adapters: ExchangeAdapter[] = [
  new BinanceSpotAdapter(),
  new BinanceFuturesAdapter(),
  // new BybitFuturesAdapter(),
  // new OkxSpotAdapter(),
]

const tickerMap = new Map<string, UnifiedTicker>()
const EXCHANGE_PRIORITY: Record<string, number> = {
  'binance-futures': 5,
  'bybit-futures': 4,
  'okx-spot': 3,
  'binance-spot': 2,
}

function pickBest(tickers: UnifiedTicker[]): Map<string, UnifiedTicker> {
  const best = new Map<string, UnifiedTicker>()
  for (const t of tickers) {
    const existing = best.get(t.symbol)
    if (!existing || EXCHANGE_PRIORITY[t.exchange] > EXCHANGE_PRIORITY[existing.exchange]) {
      best.set(t.symbol, t)
    }
  }
  return best
}

let lastBroadcast = 0
const BROADCAST_INTERVAL = 50 // 50ms for near real-time
let loggedFirst = false
let tickerCount = 0
const metricsMap = new Map<string, { range1m: number; natr5m: number }>()

export function startAggregator() {
  for (const adapter of adapters) {
    adapter.onTicker((ticker) => {
      const m = metricsMap.get(ticker.symbol)
      if (m) {
        ticker.range1m = m.range1m
        ticker.natr5m = m.natr5m
      }
      tickerMap.set(`${ticker.symbol}:${ticker.exchange}`, ticker)
      tickerCount++
      const now = Date.now()
      if (now - lastBroadcast > BROADCAST_INTERVAL) {
        lastBroadcast = now
        const best = pickBest(Array.from(tickerMap.values()))
        const arr = Array.from(best.values())
        if (!loggedFirst) {
          loggedFirst = true
          console.log(`[Aggregator] First broadcast: ${arr.length} coins (received ${tickerCount} ticks), top: ${arr.slice(0, 3).map(t => t.symbol).join(', ')}`)
        }
        broadcast({ type: 'ticker', data: arr })
      }
    })

    adapter.onCandle((candle) => {
      broadcast({ type: 'candle', channel: `candle:${candle.symbol}:${candle.timeframe}`, data: candle })
    })

    adapter.onDepth((depth) => {
      broadcast({ type: 'depth', channel: `depth:${depth.symbol}`, data: depth })
    })

    console.log(`[Aggregator] Starting adapter: ${adapter.name} (${adapter.exchange})`)
    adapter.connect()
  }

  computeMetrics()
}

async function computeMetrics() {
  const compute = async () => {
    const best = pickBest(Array.from(tickerMap.values()))
    const topCoins = Array.from(best.values())
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 200)

    for (const coin of topCoins) {
      try {
        const candles1m = await fetchCandles(coin.symbol, '1m', 5, coin.exchange)
        if (candles1m.length >= 2) {
          const highs = candles1m.map(c => c.high)
          const lows = candles1m.map(c => c.low)
          const minLow = Math.min(...lows)
          const maxHigh = Math.max(...highs)
          const range1m = minLow > 0 ? ((maxHigh - minLow) / minLow) * 100 : 0
          metricsMap.set(coin.symbol, { ...(metricsMap.get(coin.symbol) || { natr5m: 0 }), range1m })
        }

        const candles5m = await fetchCandles(coin.symbol, '5m', 14, coin.exchange)
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
      } catch {}
    }

    console.log(`[Metrics] Updated range1m/natr5m for top ${topCoins.length} coins`)
  }

  await compute()
  setInterval(compute, 30000)
}

export function getTickers(): UnifiedTicker[] {
  return Array.from(pickBest(Array.from(tickerMap.values())).values())
}

export function getTicker(symbol: string): UnifiedTicker | undefined {
  const all = Array.from(tickerMap.values()).filter(t => t.symbol === symbol)
  const best = pickBest(all)
  return best.get(symbol)
}

export async function fetchCandles(symbol: string, tf: string, limit: number, exchange?: Exchange): Promise<UnifiedCandle[]> {
  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  const adapter = adapters.find(a => a.exchange === targetExchange)
  if (!adapter) return []
  try {
    return await adapter.fetchCandles(symbol, tf, limit)
  } catch {
    const fallback = adapters.find(a => a.exchange !== targetExchange)
    if (fallback) return await fallback.fetchCandles(symbol, tf, limit)
    return []
  }
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
