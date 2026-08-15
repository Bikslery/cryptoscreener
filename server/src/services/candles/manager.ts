import type { CandleCallback, ExchangeAdapter } from '../exchanges/types.js'
import { broadcastToChannel } from '../../ws/hub.js'
import { getTicker } from '../aggregator/index.js'
import type { UnifiedCandle, Exchange } from '../../types.js'
import { subscribeAggTrade, unsubscribeAggTrade } from '../trades/aggTrade.js'
import { getRedisPub, REDIS_ENABLED } from '../../redis.js'
import { repairCacheWindow } from './repair.js'

// Exchanges are honest, independent sources: the client picks the source
// explicitly (binance-spot / binance-futures / bybit-futures) and candles are
// NEVER relabeled from one exchange to another.

// Track which exchange adapter is subscribed to which exchange+symbol+timeframe
const activeCandleSubs = new Map<string, { adapter: ExchangeAdapter; count: number }>()
const activeDepthSubs = new Map<string, { adapter: ExchangeAdapter; count: number }>()

// --- DIAGNOSTICS: inbound candle continuity --------------------------------
// Answers the question "does the server already receive holes from the
// exchange adapter (Binance kline WS / REST fallback), or is the stream
// continuous?" Counters run always (cheap); ring buffer + verbose console
// logs are thin. Toggle verbose logs with env DIAG_LOG=1.
const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}
const DIAG_LOG = process.env.DIAG_LOG === '1'

export interface GapEvent {
  ts: number
  key: string
  from: number
  to: number
  periods: number
}

export interface CandleDiagStats {
  candlesReceived: number
  gapsDetected: number
  gapsSkippedLarge: number
  lateCandles: number
  oddCandles: number
  lastSeenCount: number
  recentGaps: GapEvent[]
}

const candleDiagState = {
  candlesReceived: 0,
  gapsDetected: 0,
  gapsSkippedLarge: 0,
  lateCandles: 0,
  oddCandles: 0,
  lastSeen: new Map<string, number>(),
  lastCandleRange: new Map<string, number>(),
  recentGaps: [] as GapEvent[],
}
const MAX_RECENT_GAPS = 50

// --- Candle-lane coalescing --------------------------------------------------
// Exchange kline streams push an update per TRADE while a period forms, so an
// active symbol produced a per-trade WS frame flood (on top of the per-trade
// trade lane) that saturated the client's parse queue — the chart fell behind
// the real стакан. Kline snapshots are CUMULATIVE, so latest-wins coalescing
// loses nothing: the newest snapshot fully replaces the pending one. A CLOSED
// bar (isFinal) flushes immediately — the client's bar handoff waits on it.
const CANDLE_LANE_INTERVAL_MS = parseInt(process.env.CANDLE_LANE_INTERVAL_MS || '50', 10)
const pendingCandles = new Map<string, UnifiedCandle>()
let candleFlushTimer: ReturnType<typeof setTimeout> | null = null

function queueCandle(channel: string, candle: UnifiedCandle): void {
  pendingCandles.set(channel, candle)
  if (candleFlushTimer === null) {
    candleFlushTimer = setTimeout(flushPendingCandles, CANDLE_LANE_INTERVAL_MS)
  }
}

function flushPendingCandles(): void {
  candleFlushTimer = null
  for (const [channel, candle] of pendingCandles) {
    pendingCandles.delete(channel)
    broadcastToChannel(channel, candle, true)
  }
}

/** Flush the coalesced candle lane immediately (closed bars, teardown). */
export function flushCandleLane(): void {
  if (candleFlushTimer !== null) {
    clearTimeout(candleFlushTimer)
    candleFlushTimer = null
  }
  flushPendingCandles()
}

function recordInboundCandle(candle: UnifiedCandle): GapEvent | null {
  candleDiagState.candlesReceived++
  const key = `${candle.exchange}:${candle.symbol}:${candle.timeframe}`
  const prev = candleDiagState.lastSeen.get(key)
  candleDiagState.lastSeen.set(key, candle.time)
  if (prev == null) return null
  if (candle.time === prev) return null // normal repeat update of the same period
  if (candle.time < prev) {
    candleDiagState.lateCandles++
    return null
  }
  // Phantom-candle watchdog: a candle whose range explodes vs its own previous
  // step (>25x) is a strong outlier signal on the inbound lane (whatever the
  // exchange/fallback actually sent). Reported as diag only — no mutation.
  const thisRange = candle.high - candle.low
  const prevRange = candleDiagState.lastCandleRange.get(key)
  candleDiagState.lastCandleRange.set(key, thisRange)
  if (prevRange != null && prevRange > 1e-12 && thisRange > prevRange * 25) {
    candleDiagState.oddCandles++
    if (DIAG_LOG) {
      console.warn(
        `[Diag][Manager] Anomalous inbound candle ${key} time=${candle.time} range=${thisRange} vs prev=${prevRange} (×${(thisRange / prevRange).toFixed(0)})`
      )
    }
  }

  const tfSec = TF_SECONDS[candle.timeframe] || 60
  const periods = Math.round((candle.time - prev) / tfSec)
  if (periods <= 1) return null
  const missing = periods - 1
  candleDiagState.gapsDetected++
  const ev: GapEvent = {
    ts: Date.now(),
    key,
    from: prev + tfSec,
    to: candle.time - tfSec,
    periods: missing,
  }
  if (missing > 10) candleDiagState.gapsSkippedLarge++
  candleDiagState.recentGaps.push(ev)
  if (candleDiagState.recentGaps.length > MAX_RECENT_GAPS) candleDiagState.recentGaps.shift()
  if (DIAG_LOG) {
    console.warn(
      `[Diag][Manager] Candle gap on server input ${key}: missing ${missing} periods [${ev.from}..${ev.to}]`
    )
  }
  return ev
}

export function getCandleDiagStats(): CandleDiagStats {
  return {
    candlesReceived: candleDiagState.candlesReceived,
    gapsDetected: candleDiagState.gapsDetected,
    gapsSkippedLarge: candleDiagState.gapsSkippedLarge,
    lateCandles: candleDiagState.lateCandles,
    oddCandles: candleDiagState.oddCandles,
    lastSeenCount: candleDiagState.lastSeen.size,
    recentGaps: candleDiagState.recentGaps.slice(-MAX_RECENT_GAPS),
  }
}

export function getCandleManagerStats() {
  const byTimeframe: Record<string, { subscriptions: number; clients: number }> = {}
  for (const [key, sub] of activeCandleSubs) {
    // Key format is now exchange:symbol:tf
    const parts = key.split(':')
    const tf = parts[2] || 'unknown'
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

function getChannelKey(exchange: string, symbol: string, tf: string) {
  return `${exchange}:${symbol}:${tf}`
}

function getDepthKey(symbol: string) {
  return symbol
}

function getBestAdapter(symbol: string, adapters: ExchangeAdapter[], preferredExchange?: Exchange): ExchangeAdapter | null {
  // If preferred exchange is specified, use it
  if (preferredExchange) {
    const preferred = adapters.find(a => a.exchange === preferredExchange)
    if (preferred) return preferred
  }
  // Fallback: use exchange from ticker (consistency with displayed price)
  const ticker = getTicker(symbol)
  if (ticker) {
    const adapter = adapters.find(a => a.exchange === ticker.exchange)
    if (adapter) return adapter
  }
  // Last resort: spot (more reliable WS)
  const spotAdapter = adapters.find(a => a.type === 'spot')
  if (spotAdapter) return spotAdapter
  return adapters[0] || null
}

export function createCandleManager(adapters: ExchangeAdapter[]) {
  const candleCallback: CandleCallback = (candle: UnifiedCandle) => {
    const channel = `candle:${candle.exchange}:${candle.symbol}:${candle.timeframe}`
    const gap = recordInboundCandle(candle)
    if (candle.isFinal) {
      // A closed bar lands immediately: pending forming klines for the same
      // channel are superseded by this final snapshot, and the client's bar
      // handoff (next period's open) waits on it.
      queueCandle(channel, candle)
      flushCandleLane()
    } else {
      queueCandle(channel, candle)
    }
    if (gap) {
      // INSTANT REPAIR: the stream skipped periods → the cache just got flat
      // placeholders for them. Replace them with real exchange rows right away
      // (deduped in-flight, rate-limit aware inside getHistory).
      repairCacheWindow(candle.symbol, candle.timeframe, candle.exchange)
        .then(ev => {
          if (ev && DIAG_LOG) {
            console.warn(`[Diag][Manager] cache repaired after inbound gap ${ev.key}: filled=${ev.filledReal}/${ev.periodsMissing}`)
          }
        })
        .catch(() => {})
    }
  }

  const depthCallback = (depth: any) => {
    const channel = `depth:${depth.symbol}`
    broadcastToChannel(channel, depth, true)
  }

  return {
    subscribeCandle(exchange: string, symbol: string, tf: string) {
      const key = getChannelKey(exchange, symbol, tf)
      const existing = activeCandleSubs.get(key)
      if (existing) {
        existing.count++
        return
      }

      // Use the specified exchange, or fall back to best adapter
      const adapter = getBestAdapter(symbol, adapters, exchange as Exchange)
      if (!adapter) {
        console.error(`[CandleManager] No adapter available for ${exchange}:${symbol}`)
        return
      }
      console.log(`[CandleManager] subscribeCandle NEW key=${key} adapter=${adapter.name}`)

      const cb: CandleCallback = candleCallback
      adapter.subscribeCandle(symbol, tf, cb)
      activeCandleSubs.set(key, { adapter, count: 1 })
      if (adapter.exchange === 'binance-futures' || adapter.exchange === 'binance-spot') {
        subscribeAggTrade(symbol, adapter.exchange)
      }
      console.log(`[CandleManager] Subscribed to ${key} via ${adapter.name}`)
    },

    unsubscribeCandle(exchange: string, symbol: string, tf: string) {
      const key = getChannelKey(exchange, symbol, tf)
      const existing = activeCandleSubs.get(key)
      if (!existing) return

      existing.count--
      if (existing.count <= 0) {
        existing.adapter.unsubscribeCandle(symbol, tf)
        activeCandleSubs.delete(key)
        if (existing.adapter.exchange === 'binance-futures' || existing.adapter.exchange === 'binance-spot') {
          unsubscribeAggTrade(symbol, existing.adapter.exchange)
        }
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

// Broadcast-node variant: this node never connects to the exchanges — realtime
// candle/depth/trade data arrives via Redis from the ingestion node. Client
// subscriptions are forwarded to the ingestion node as 'sub-req' messages, and
// reference counting happens here so unsubscribes balance out.
export function createRemoteCandleManager() {
  const counts = new Map<string, number>()

  const publish = (type: string, data: Record<string, unknown>) => {
    if (!REDIS_ENABLED) return
    try {
      getRedisPub().publish('sub-req', JSON.stringify({ type, ...data })).catch(() => {})
    } catch { /* redis down */ }
  }

  return {
    subscribeCandle(exchange: string, symbol: string, tf: string) {
      const key = getChannelKey(exchange, symbol, tf)
      const n = counts.get(key) || 0
      counts.set(key, n + 1)
      if (n === 0) publish('subscribe', { exchange, symbol, tf })
    },

    unsubscribeCandle(exchange: string, symbol: string, tf: string) {
      const key = getChannelKey(exchange, symbol, tf)
      const n = counts.get(key) ?? 1
      if (n <= 1) {
        counts.delete(key)
        publish('unsubscribe', { exchange, symbol, tf })
      } else {
        counts.set(key, n - 1)
      }
    },

    subscribeDepth(symbol: string) {
      const key = `d:${getDepthKey(symbol)}`
      const n = counts.get(key) || 0
      counts.set(key, n + 1)
      if (n === 0) publish('depth-sub', { symbol })
    },

    unsubscribeDepth(symbol: string) {
      const key = `d:${getDepthKey(symbol)}`
      const n = counts.get(key) ?? 1
      if (n <= 1) {
        counts.delete(key)
        publish('depth-unsub', { symbol })
      } else {
        counts.set(key, n - 1)
      }
    },
  }
}
