import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken, type JwtPayload } from '../middleware/auth.js'
import type { WsMessage } from '../types.js'
import type { UnifiedTicker, UnifiedCandle } from '../types.js'
import { getTopCachedSymbols, getCachedCandles } from '../services/candles/candle-cache.js'
import { getAllTickers, getTickers, getTicker, setTickersFromRedis } from '../services/aggregator/index.js'
import { INITIAL_CANDLES_TF } from '../services/candles/preload.js'
import { getRedisSub } from '../redis.js'
import {
  wsClientsGauge,
  wsSubscriptionsGauge,
  wsBufferedMaxGauge,
  wsDroppedTotal,
  wsClientKilledTotal,
  wsBroadcastLatency,
  wsBatchFlushLatency,
} from '../metrics.js'

interface Client {
  ws: WebSocket
  user: JwtPayload | null
  subscriptions: Set<string>
  tickerSymbols: Set<string>
  alive: boolean
  buffered: number
  lastBackpressureNotify: number
  totalDropped: number
}

const clients = new Map<WebSocket, Client>()
const MAX_BUFFERED = 50
const BACKPRESSURE_HARD_LIMIT = MAX_BUFFERED * 2
const BACKPRESSURE_NOTIFY_INTERVAL = 5000

const CLIENT_PING_INTERVAL = 30_000
let clientPingTimer: ReturnType<typeof setInterval> | null = null

let candleManager: {
  subscribeCandle: (exchange: string, symbol: string, tf: string) => void
  unsubscribeCandle: (exchange: string, symbol: string, tf: string) => void
  subscribeDepth: (symbol: string) => void
  unsubscribeDepth: (symbol: string) => void
} | null = null

export function setCandleManager(cm: typeof candleManager) {
  candleManager = cm
}

const wsBatchBuffer = new Map<string, unknown>()

function handleBackpressure(client: Client): boolean {
  client.totalDropped++
  wsDroppedTotal.inc()
  if (client.buffered >= BACKPRESSURE_HARD_LIMIT) {
    console.warn(`[Hub] Client dropped (backpressure), buffered=${client.buffered}, totalDropped=${client.totalDropped}`)
    wsClientKilledTotal.inc()
    client.ws.close(1008, 'backpressure')
    cleanupClient(client)
    clients.delete(client.ws)
    return true // removed
  }
  if (Date.now() - client.lastBackpressureNotify > BACKPRESSURE_NOTIFY_INTERVAL) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'backpressure', dropped: true }))
    }
    client.lastBackpressureNotify = Date.now()
  }
  return false // still connected
}

function flushBatchBuffer() {
  if (wsBatchBuffer.size === 0) return
  const endTimer = wsBatchFlushLatency.startTimer()
  try {
    for (const [channel, data] of wsBatchBuffer) {
      const msg: WsMessage = { type: channel as any, channel, data }
      let raw: string | null = null
      for (const client of clients.values()) {
        if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
          if (client.buffered >= MAX_BUFFERED) {
            handleBackpressure(client)
            continue
          }
          if (raw === null) raw = JSON.stringify(msg)
          client.ws.send(raw, (err) => { if (err) client.buffered++ })
        }
      }
    }
    wsBatchBuffer.clear()
  } finally {
    endTimer()
  }
}

let batchTimer: ReturnType<typeof setInterval> | null = setInterval(flushBatchBuffer, 100)

export function stopWsHub() {
  if (batchTimer) { clearInterval(batchTimer); batchTimer = null }
  if (clientPingTimer) { clearInterval(clientPingTimer); clientPingTimer = null }
}

function parseCandleChannel(channel: string): { exchange: string; symbol: string; tf: string } | null {
  const match = channel.match(/^candle:([^:]+):([^:]+):(.+)$/)
  if (!match) return null
  return { exchange: match[1], symbol: match[2], tf: match[3] }
}

function parseDepthChannel(channel: string): string | null {
  const match = channel.match(/^depth:(.+)$/)
  if (!match) return null
  return match[1]
}

const INITIAL_CANDLES_LIMIT = 100

function buildInitialCandlesData(): Record<string, any[]> {
  let topSymbols = getTopCachedSymbols(INITIAL_CANDLES_TF, 9)
  if (topSymbols.length < 9) {
    const tickers = getTickers()
    const tickerTop = tickers
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 9)
      .map(t => t.symbol)
    const combined = [...topSymbols]
    for (const s of tickerTop) {
      if (!combined.includes(s) && combined.length < 9) combined.push(s)
    }
    topSymbols = combined
  }

  const result: Record<string, any[]> = {}
  for (const symbol of topSymbols) {
    const exchange = getTicker(symbol)?.exchange
    const cached = getCachedCandles(symbol, INITIAL_CANDLES_TF, exchange)
    if (cached && cached.length > 0) {
      // Key with exchange so it matches the client cache's
      // `${exchange}:${symbol}:${tf}` lookup (storeBulk).
      const ex = exchange || cached[0]?.exchange
      const payloadKey = ex
        ? `${ex}:${symbol}:${INITIAL_CANDLES_TF}`
        : `${symbol}:${INITIAL_CANDLES_TF}`
      result[payloadKey] = cached.slice(-INITIAL_CANDLES_LIMIT)
    }
  }
  return result
}

function cleanupClient(client: Client) {
  if (candleManager) {
    for (const channel of client.subscriptions) {
      const candleInfo = parseCandleChannel(channel)
      if (candleInfo) candleManager.unsubscribeCandle(candleInfo.exchange, candleInfo.symbol, candleInfo.tf)
      const depthSymbol = parseDepthChannel(channel)
      if (depthSymbol) candleManager.unsubscribeDepth(depthSymbol)
    }
  }
}

export function setupWsHub(wss: WebSocketServer) {
  wss.on('connection', (ws, req) => {
    let user: JwtPayload | null = null

    const url = new URL(req.url || '', `http://${req.headers.host}`)
    let token = url.searchParams.get('token')
    // Fallback: read token from cookie (for cookie-based auth)
    if (!token && req.headers.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/)
      if (match) token = match[1]
    }
    if (token) {
      user = verifyToken(token)
    }

    const client: Client = {
      ws, user,
      subscriptions: new Set(),
      tickerSymbols: new Set(),
      alive: true,
      buffered: 0,
      lastBackpressureNotify: 0,
      totalDropped: 0,
    }
    clients.set(ws, client)

    ws.on('pong', () => { client.alive = true; client.buffered = 0 })

    try {
      const initialCandles = buildInitialCandlesData()
      if (Object.keys(initialCandles).length > 0) {
        ws.send(JSON.stringify({ type: 'initial-candles', data: initialCandles }))
      }
    } catch (err) {
      console.warn('[Hub] Failed to send initial-candles', err)
    }

    try {
      const tickers = getAllTickers()
      if (tickers.length > 0) {
        ws.send(JSON.stringify({ type: 'ticker', data: tickers }))
        console.log(`[Hub] Sent initial tickers to new client: ${tickers.length} tickers`)
      }
    } catch (err) {
      console.warn('[Hub] Failed to send initial-tickers', err)
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage

        // Support auth via first WS message (avoids token in URL which gets logged)
        if (msg.type === 'auth' && msg.token && !client.user) {
          client.user = verifyToken(msg.token as string)
          return
        }

        if (msg.type === 'subscribe' && msg.channel) {
          const isNew = !client.subscriptions.has(msg.channel)
          client.subscriptions.add(msg.channel)

          if (msg.channel.startsWith('ticker:')) {
            const symbol = msg.channel.slice(7)
            client.tickerSymbols.add(symbol)
          }

          if (isNew) {
            const candleInfo = parseCandleChannel(msg.channel)
            if (candleInfo && candleManager) {
              candleManager.subscribeCandle(candleInfo.exchange, candleInfo.symbol, candleInfo.tf)
            }

            const depthSymbol = parseDepthChannel(msg.channel)
            if (depthSymbol && candleManager) {
              candleManager.subscribeDepth(depthSymbol)
            }
          }
        } else if (msg.type === 'unsubscribe' && msg.channel) {
          client.subscriptions.delete(msg.channel)

          if (msg.channel.startsWith('ticker:')) {
            client.tickerSymbols.delete(msg.channel.slice(7))
          }

          const candleInfo = parseCandleChannel(msg.channel)
          if (candleInfo && candleManager) {
            candleManager.unsubscribeCandle(candleInfo.exchange, candleInfo.symbol, candleInfo.tf)
          }

          const depthSymbol = parseDepthChannel(msg.channel)
          if (depthSymbol && candleManager) {
            candleManager.unsubscribeDepth(depthSymbol)
          }
        }
      } catch (e) {
        console.warn('[Hub] message handler error:', e instanceof Error ? e.message : e)
      }
    })

    ws.on('close', () => {
      cleanupClient(client)
      clients.delete(ws)
    })
  })

  if (!clientPingTimer) {
    clientPingTimer = setInterval(() => {
      for (const [ws, client] of clients) {
        if (!client.alive) {
          ws.terminate()
          cleanupClient(client)
          clients.delete(ws)
          continue
        }
        client.alive = false
        ws.ping()
      }
    }, CLIENT_PING_INTERVAL)
  }
}

export function broadcast(msg: WsMessage) {
  const endTimer = wsBroadcastLatency.startTimer()
  try {
    const raw = JSON.stringify(msg)
    const channel = msg.channel || msg.type
    const isGlobal = msg.type === 'alert' || msg.type === 'listing'

    if (msg.type === 'ticker') {
      const tickers = msg.data as UnifiedTicker[]
      const fullTickers = msg.full as UnifiedTicker[] | undefined

      // For global subscribers: send full array once (not delta)
      // For per-client: filter from full array
      const sourceForAll = fullTickers || tickers

      // Serialization cache: group by ticker signature
      const sigCache = new Map<string, string>()
      let fullRaw: string | null = null
      let sentCount = 0

      for (const client of clients.values()) {
        if (client.ws.readyState !== WebSocket.OPEN) continue
        if (client.buffered >= MAX_BUFFERED) {
          handleBackpressure(client)
          continue
        }

        if (client.tickerSymbols.size === 0) {
          // Subscribed to all tickers — send full array for state merge
          if (fullRaw === null) {
            fullRaw = JSON.stringify({ type: 'ticker', data: sourceForAll })
          }
          client.ws.send(fullRaw, (err) => { if (err) client.buffered++ })
          sentCount++
        } else {
          // Per-client filtered tickers — filter from full array, cache by signature
          const sig = [...client.tickerSymbols].sort().join(',')
          let cached = sigCache.get(sig)
          if (cached === undefined) {
            const filtered = (fullTickers || tickers).filter(t => client.tickerSymbols.has(t.symbol))
            cached = filtered.length > 0
              ? JSON.stringify({ type: 'ticker', data: filtered })
              : ''
            sigCache.set(sig, cached)
          }
          if (cached) {
            client.ws.send(cached, (err) => { if (err) client.buffered++ })
            sentCount++
          }
        }
      }
      return
    }

    for (const client of clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue
      if (client.buffered >= MAX_BUFFERED) {
        handleBackpressure(client)
        continue
      }
      if (isGlobal || client.subscriptions.has(channel)) {
        client.ws.send(raw, (err) => { if (err) client.buffered++ })
      }
    }
  } finally {
    endTimer()
  }
}

export function broadcastToChannel(channel: string, data: unknown, immediate = false) {
  if (immediate) {
    const msg: WsMessage = { type: channel as any, channel, data }
    const raw = JSON.stringify(msg)
    for (const client of clients.values()) {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN && client.buffered < MAX_BUFFERED) {
        client.ws.send(raw, (err) => { if (err) client.buffered++ })
      }
    }
  } else {
    wsBatchBuffer.set(channel, data)
  }
}

export function startRedisListener() {
  try {
    const sub = getRedisSub()

    sub.on('message', (channel, message) => {
      try {
        if (channel === 'tickers') {
          const tickers = JSON.parse(message) as UnifiedTicker[]
          setTickersFromRedis(tickers)
          broadcast({ type: 'ticker', data: tickers })
        } else if (channel === 'candles') {
          const candle = JSON.parse(message) as UnifiedCandle
          broadcastToChannel(`candle:${candle.exchange}:${candle.symbol}:${candle.timeframe}`, candle, true)
        } else if (channel === 'depth') {
          const depth = JSON.parse(message)
          broadcastToChannel(`depth:${depth.symbol}`, depth)
        } else if (channel === 'trades') {
          const trade = JSON.parse(message)
          broadcastToChannel(`trade:${trade.exchange}:${trade.symbol}`, trade)
        } else if (channel === 'alerts') {
          broadcast({ type: 'alert', data: JSON.parse(message) })
        }
      } catch (e) {
        console.warn('[Hub] Redis message parse error:', e instanceof Error ? e.message : e)
      }
    })

    console.log('[Hub] Redis listener started')
  } catch (e) {
    console.warn('[Hub] Redis unavailable, running in single-process mode')
  }
}

export function getHubStats() {
  let totalClients = 0
  let totalSubscriptions = 0
  let maxBuffered = 0
  let totalDropped = 0
  for (const c of clients.values()) {
    totalClients++
    totalSubscriptions += c.subscriptions.size
    if (c.buffered > maxBuffered) maxBuffered = c.buffered
    totalDropped += c.totalDropped
  }
  return { totalClients, totalSubscriptions, maxBuffered, totalDropped }
}

let lastDroppedSnapshot = 0

export function refreshMetrics() {
  const stats = getHubStats()
  wsClientsGauge.set(stats.totalClients)
  wsSubscriptionsGauge.set(stats.totalSubscriptions)
  wsBufferedMaxGauge.set(stats.maxBuffered)
  // Delta for the counter that was incremented per-event in handleBackpressure
  // totalDropped in stats includes historical drops from dead clients,
  // but the wsDroppedTotal counter already tracks live increments.
  lastDroppedSnapshot = stats.totalDropped
}
