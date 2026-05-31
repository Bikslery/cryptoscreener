import type { CandleCallback, ExchangeAdapter } from '../exchanges/types.js'
import { broadcastToChannel } from '../../ws/hub.js'
import { getTicker } from '../aggregator/index.js'
import type { UnifiedCandle } from '../../types.js'
import { subscribeAggTrade, unsubscribeAggTrade } from '../trades/aggTrade.js'

// Track which exchange adapter is subscribed to which symbol+timeframe
const activeCandleSubs = new Map<string, { adapter: ExchangeAdapter; count: number }>()
const activeDepthSubs = new Map<string, { adapter: ExchangeAdapter; count: number }>()

export function getCandleManagerStats() {
  const byTimeframe: Record<string, { subscriptions: number; clients: number }> = {}
  for (const [key, sub] of activeCandleSubs) {
    const tf = key.split(':')[1] || 'unknown'
    const stats = byTimeframe[tf] || { subscriptions: 0, clients: 0 }
    stats.subscriptions++
    stats.clients += sub.count
    byTimeframe[tf] = stats
  }
  return {
    candles: activeCandleSubs.size,
    depth: activeDepthSubs.size,
    candleClients: Array.from(activeCandleSubs.values()).reduce((sum, sub) => sum + sub.count, 0),
    depthClients: Array.from(activeDepthSubs.values()).reduce((sum, sub) => sum + sub.count, 0),
    byTimeframe,
  }
}

function getChannelKey(symbol: string, tf: string) {
  return `${symbol}:${tf}`
}

function getDepthKey(symbol: string) {
  return symbol
}

function getBestAdapter(symbol: string, adapters: ExchangeAdapter[]): ExchangeAdapter | null {
  // Prefer spot adapter for WebSocket (Binance spot WS works, futures may be blocked)
  const spotAdapter = adapters.find(a => a.type === 'spot')
  if (spotAdapter) return spotAdapter
  // Fallback: use adapter matching ticker exchange
  const ticker = getTicker(symbol)
  if (ticker) {
    const adapter = adapters.find(a => a.exchange === ticker.exchange)
    if (adapter) return adapter
  }
  return adapters[0] || null
}

export function createCandleManager(adapters: ExchangeAdapter[]) {
  const candleCallback: CandleCallback = (candle: UnifiedCandle) => {
    const channel = `candle:${candle.symbol}:${candle.timeframe}`
    broadcastToChannel(channel, candle, true)
  }

  const depthCallback = (depth: any) => {
    const channel = `depth:${depth.symbol}`
    broadcastToChannel(channel, depth, true)
  }

  return {
    subscribeCandle(symbol: string, tf: string) {
      const key = getChannelKey(symbol, tf)
      const existing = activeCandleSubs.get(key)
      if (existing) {
        existing.count++
        return
      }

      const adapter = getBestAdapter(symbol, adapters)
      if (!adapter) {
        console.error(`[CandleManager] No adapter available for ${symbol}`)
        return
      }

      adapter.subscribeCandle(symbol, tf, candleCallback)
      activeCandleSubs.set(key, { adapter, count: 1 })
      subscribeAggTrade(symbol, adapter.exchange)
      console.log(`[CandleManager] Subscribed to ${key} via ${adapter.name}`)
    },

    unsubscribeCandle(symbol: string, tf: string) {
      const key = getChannelKey(symbol, tf)
      const existing = activeCandleSubs.get(key)
      if (!existing) return

      existing.count--
      if (existing.count <= 0) {
        existing.adapter.unsubscribeCandle(symbol, tf)
        activeCandleSubs.delete(key)
        unsubscribeAggTrade(symbol, existing.adapter.exchange)
        console.log(`[CandleManager] Unsubscribed from ${key}`)
      }
    },

    subscribeDepth(symbol: string) {
      const key = getDepthKey(symbol)
      const existing = activeDepthSubs.get(key)
      if (existing) {
        existing.count++
        return
      }

      const adapter = getBestAdapter(symbol, adapters)
      if (!adapter) return

      adapter.subscribeDepth(symbol, depthCallback)
      activeDepthSubs.set(key, { adapter, count: 1 })
      console.log(`[CandleManager] Subscribed to depth ${key}`)
    },

    unsubscribeDepth(symbol: string) {
      const key = getDepthKey(symbol)
      const existing = activeDepthSubs.get(key)
      if (!existing) return

      existing.count--
      if (existing.count <= 0) {
        existing.adapter.unsubscribeDepth(symbol)
        activeDepthSubs.delete(key)
        console.log(`[CandleManager] Unsubscribed from depth ${key}`)
      }
    },
  }
}
