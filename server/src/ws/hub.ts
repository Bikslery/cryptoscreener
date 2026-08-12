import { deflateRawSync } from 'zlib'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken, type JwtPayload } from '../middleware/auth.js'
import type { WsMessage } from '../types.js'
import type { UnifiedTicker, UnifiedCandle } from '../types.js'
import { getTopCachedSymbols, getCachedCandles, updateCachedCandle } from '../services/candles/candle-cache.js'
import { getAllTickers, getTickers, getTicker, setTickersFromRedis } from '../services/aggregator/index.js'
import { INITIAL_CANDLES_TF } from '../services/candles/preload.js'
import { compactCandles, type CompactCandle } from '../services/candles/compact.js'
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

// Outbound WS frames are deflate-raw compressed binary (same approach as
// scalpboard) instead of plain JSON text — the browser decompresses via
// DecompressionStream('deflate-raw'). Ticker snapshots shrink ~10x;
// perMessageDeflate is disabled on the server to avoid double-compressing.
//
// Small frames (ticker deltas, candle/trade/price updates) go out as plain
// JSON text instead: DecompressionStream is async, so compressing a 1-3KB
// delta costs more latency than it saves — the client parses text frames
// synchronously (no decompression, no extra microtask chain behind big
// frames). Only frames above PLAIN_FRAME_MAX_BYTES get deflated.
const PLAIN_FRAME_MAX_BYTES = 4096

function encodePayload(data: unknown): Buffer | string {
  const json = JSON.stringify(data)
  if (json.length <= PLAIN_FRAME_MAX_BYTES) return json
  return deflateRawSync(json)
}

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
      client.ws.send(encodePayload({ type: 'backpressure', dropped: true }))
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
      let raw: Buffer | string | null = null
      for (const client of clients.values()) {
        if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
          if (client.buffered >= MAX_BUFFERED) {
            handleBackpressure(client)
            continue
          }
          if (raw === null) raw = encodePayload(msg)
          client.ws.send(raw, (err) => { if (err) client.buffered++ })
        }
      }
    }
    wsBatchBuffer.clear()
  } finally {
    endTimer()
  }
}

// Channel batches (depth/trades) flush every WS_BATCH_INTERVAL_MS — the
// immediate per-symbol channels (candles, trades for subscribed charts) are
// not affected by this timer.
const WS_BATCH_INTERVAL_MS = parseInt(process.env.WS_BATCH_INTERVAL_MS || '40', 10)
let batchTimer: ReturnType<typeof setInterval> | null = setInterval(flushBatchBuffer, WS_BATCH_INTERVAL_MS)

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

// 300 candles matches the grid's initial load (GRID_CANDLE_LIMIT on the
// client), so the first screen can render entirely from this push without
// falling back to REST. Compact tuples keep the payload small (+ ws
// perMessageDeflate is enabled).
const INITIAL_CANDLES_LIMIT = 300

function buildInitialCandlesData(): Record<string, CompactCandle[]> {
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

  const result: Record<string, CompactCandle[]> = {}
  for (const symbol of topSymbols) {
    const exchange = getTicker(symbol)?.exchange
    const cached = getCachedCandles(symbol, INITIAL_CANDLES_TF, exchange)
    if (cached && cached.length > 0) {
      // Key with exchange so it matches the client cache's
      // `${exchange}:${symbol}:${tf}` lookup (storeBulk). Entries without a
      // known exchange are skipped — the client could never read them back.
      const ex = exchange || cached[0]?.exchange
      if (!ex) continue
      const payloadKey = `${ex}:${symbol}:${INITIAL_CANDLES_TF}`
      result[payloadKey] = compactCandles(cached.slice(-INITIAL_CANDLES_LIMIT))
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
        ws.send(encodePayload({ type: 'initial-candles', format: 'compact', data: initialCandles }))
      }
    } catch (err) {
      console.warn('[Hub] Failed to send initial-candles', err)
    }

    try {
      const tickers = getAllTickers()
      if (tickers.length > 0) {
        ws.send(encodePayload({ type: 'ticker', data: tickers }))
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
    const channel = msg.channel || msg.type
    const isGlobal = msg.type === 'alert' || msg.type === 'listing'

    if (msg.type === 'ticker') {
      const tickers = msg.data as UnifiedTicker[]
      const fullTickers = msg.full as UnifiedTicker[] | undefined
      const isSnapshot = !!(msg as { snapshot?: boolean }).snapshot

      // Global subscribers get compact DELTA frames every broadcast and a
      // full SNAPSHOT every ~2s (the aggregator stamps msg.snapshot). The full
      // array of all exchanges is ~1200 tickers; shipping it at 25Hz would
      // drown clients in bytes even deflated. The client merges deltas in
      // place (identity-preserving) and replaces state on snapshots.
      // Per-client filtered subscribers get the same delta/snapshot semantics.
      const globalPayload = isSnapshot ? (fullTickers || tickers) : tickers
      const filterSource = isSnapshot ? (fullTickers || tickers) : tickers

      // Serialization cache: group by ticker signature
      const sigCache = new Map<string, Buffer | string>()
      let snapshotRaw: Buffer | string | null = null
      let deltaRaw: Buffer | string | null = null
      let sentCount = 0

      for (const client of clients.values()) {
        if (client.ws.readyState !== WebSocket.OPEN) continue
        if (client.buffered >= MAX_BUFFERED) {
          handleBackpressure(client)
          continue
        }

        if (client.tickerSymbols.size === 0) {
          // Subscribed to all tickers
          if (!globalPayload || globalPayload.length === 0) continue
          let raw: Buffer | string | null = isSnapshot ? snapshotRaw : deltaRaw
          if (raw === null) {
            raw = encodePayload(isSnapshot
              ? { type: 'ticker', data: globalPayload, snapshot: true, ts: msg.ts }
              : { type: 'ticker', data: globalPayload, delta: true, ts: msg.ts })
            if (isSnapshot) snapshotRaw = raw
            else deltaRaw = raw
          }
          client.ws.send(raw, (err) => { if (err) client.buffered++ })
          sentCount++
        } else {
          // Per-client filtered tickers — filter from the frame, cache by signature
          const sig = [...client.tickerSymbols].sort().join(',')
          let cached = sigCache.get(sig)
          if (cached === undefined) {
            const filtered = filterSource.filter(t => client.tickerSymbols.has(t.symbol))
            if (filtered.length > 0) {
              cached = encodePayload(isSnapshot
                ? { type: 'ticker', data: filtered, snapshot: true, ts: msg.ts }
                : { type: 'ticker', data: filtered, delta: true, ts: msg.ts })
              sigCache.set(sig, cached)
            }
          }
          if (cached) {
            client.ws.send(cached, (err) => { if (err) client.buffered++ })
            sentCount++
          }
        }
      }
      return
    }

    const raw = encodePayload(msg)
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
    const raw = encodePayload(msg)
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
          // Ingestion nodes publish the full array; new payloads also carry
          // the delta + snapshot flag so broadcast nodes forward the same
          // compact frames their all-in-one cousins send. Plain arrays (old
          // payloads) are treated as a full snapshot.
          const parsed = JSON.parse(message)
          const isObject = !Array.isArray(parsed)
          const tickers = (isObject ? parsed.full : parsed) as UnifiedTicker[]
          const delta = (isObject && Array.isArray(parsed.delta) ? parsed.delta : tickers) as UnifiedTicker[]
          const snapshot = isObject ? !!parsed.snapshot : true
          setTickersFromRedis(tickers)
          broadcast({ type: 'ticker', data: delta, full: tickers, snapshot })
        } else if (channel === 'candles') {
          const candle = JSON.parse(message) as UnifiedCandle
          // Keep the local cache warm so initial-candles pushes and REST
          // fallbacks work even though this node never touches the exchanges.
          updateCachedCandle(candle)
          broadcastToChannel(`candle:${candle.exchange}:${candle.symbol}:${candle.timeframe}`, candle, true)
        } else if (channel === 'depth') {
          const depth = JSON.parse(message)
          broadcastToChannel(`depth:${depth.symbol}`, depth)
        } else if (channel === 'trades') {
          const trade = JSON.parse(message)
          broadcastToChannel(`trade:${trade.exchange}:${trade.symbol}`, trade)
        } else if (channel === 'alerts') {
          broadcast({ type: 'alert', data: JSON.parse(message) })
        } else if (channel === 'price') {
          // Fast-lane price updates (bookTicker mid for focused symbols) —
          // forwarded immediately, same as candle/trade channels.
          const p = JSON.parse(message)
          if (p?.symbol && typeof p.price === 'number' && isFinite(p.price)) {
            broadcastToChannel(`price:${p.symbol}`, p, true)
          }
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

// On an ingestion-only node there are no WS clients, so client candle/depth
// subscriptions arrive from broadcast nodes as Redis 'sub-req' messages.
// Drive the local candle manager, which subscribes the exchange streams and
// publishes the resulting data back to Redis for the broadcast nodes.
export function startIngestionRedisListener() {
  try {
    const sub = getRedisSub()
    sub.on('message', (channel, message) => {
      if (channel !== 'sub-req') return
      try {
        const req = JSON.parse(message)
        if (req?.type === 'subscribe' && candleManager) {
          candleManager.subscribeCandle(req.exchange, req.symbol, req.tf)
        } else if (req?.type === 'unsubscribe' && candleManager) {
          candleManager.unsubscribeCandle(req.exchange, req.symbol, req.tf)
        } else if (req?.type === 'depth-sub' && candleManager) {
          candleManager.subscribeDepth(req.symbol)
        } else if (req?.type === 'depth-unsub' && candleManager) {
          candleManager.unsubscribeDepth(req.symbol)
        }
      } catch (e) {
        console.warn('[Hub] sub-req parse error:', e instanceof Error ? e.message : e)
      }
    })
    console.log('[Hub] Ingestion Redis listener started (sub-req)')
  } catch (e) {
    console.warn('[Hub] Redis unavailable, ingestion sub-req listener disabled')
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
