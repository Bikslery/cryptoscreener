import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken, type JwtPayload } from '../middleware/auth.js'
import type { WsMessage } from '../types.js'
import { getTopCachedSymbols, getCachedCandles } from '../services/candles/candle-cache.js'
import { getTickers } from '../services/aggregator/index.js'
import { PRELOAD_TFS } from '../services/candles/preload.js'

interface Client {
  ws: WebSocket
  user: JwtPayload | null
  subscriptions: Set<string>
}

const clients = new Map<WebSocket, Client>()

let candleManager: {
  subscribeCandle: (symbol: string, tf: string) => void
  unsubscribeCandle: (symbol: string, tf: string) => void
  subscribeDepth: (symbol: string) => void
  unsubscribeDepth: (symbol: string) => void
} | null = null

export function setCandleManager(cm: typeof candleManager) {
  candleManager = cm
}

// Broadcast batching for channel messages
const wsBatchBuffer = new Map<string, unknown>()

function flushBatchBuffer() {
  if (wsBatchBuffer.size === 0) return
  for (const [channel, data] of wsBatchBuffer) {
    const msg: WsMessage = { type: channel as any, channel, data }
    const raw = JSON.stringify(msg)
    for (const [, client] of clients) {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw)
      }
    }
  }
  wsBatchBuffer.clear()
}

const batchTimer = setInterval(flushBatchBuffer, 100)

function parseCandleChannel(channel: string): { symbol: string; tf: string } | null {
  const match = channel.match(/^candle:([^:]+):(.+)$/)
  if (!match) return null
  return { symbol: match[1], tf: match[2] }
}

function parseDepthChannel(channel: string): string | null {
  const match = channel.match(/^depth:(.+)$/)
  if (!match) return null
  return match[1]
}

function buildInitialCandlesData(): Record<string, any[]> {
  // Get top-9 symbols: prefer cache-based, fallback to ticker-based
  let topSymbols = getTopCachedSymbols('5m', 9)
  if (topSymbols.length < 9) {
    const tickers = getTickers()
    const tickerTop = tickers
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 9)
      .map(t => t.symbol)
    // Merge: cache-based first, then fill with ticker-based
    const combined = [...topSymbols]
    for (const s of tickerTop) {
      if (!combined.includes(s) && combined.length < 9) combined.push(s)
    }
    topSymbols = combined
  }

  const result: Record<string, any[]> = {}
  for (const symbol of topSymbols) {
    for (const tf of PRELOAD_TFS) {
      const cached = getCachedCandles(symbol, tf)
      if (cached && cached.length > 0) {
        result[`${symbol}:${tf}`] = cached.slice(-300)
      }
    }
  }
  return result
}

export function setupWsHub(wss: WebSocketServer) {
  wss.on('connection', (ws, req) => {
    let user: JwtPayload | null = null

    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    if (token) {
      user = verifyToken(token)
    }

    const client: Client = { ws, user, subscriptions: new Set() }
    clients.set(ws, client)

    // Send initial-candles data on connect
    try {
      const initialCandles = buildInitialCandlesData()
      if (Object.keys(initialCandles).length > 0) {
        ws.send(JSON.stringify({ type: 'initial-candles', data: initialCandles }))
      }
    } catch (err) {
      console.warn('[Hub] Failed to send initial-candles', err)
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage
        if (msg.type === 'subscribe' && msg.channel) {
          client.subscriptions.add(msg.channel)

          const candleInfo = parseCandleChannel(msg.channel)
          if (candleInfo && candleManager) {
            candleManager.subscribeCandle(candleInfo.symbol, candleInfo.tf)
          }

          const depthSymbol = parseDepthChannel(msg.channel)
          if (depthSymbol && candleManager) {
            candleManager.subscribeDepth(depthSymbol)
          }
        } else if (msg.type === 'unsubscribe' && msg.channel) {
          client.subscriptions.delete(msg.channel)

          const candleInfo = parseCandleChannel(msg.channel)
          if (candleInfo && candleManager) {
            candleManager.unsubscribeCandle(candleInfo.symbol, candleInfo.tf)
          }

          const depthSymbol = parseDepthChannel(msg.channel)
          if (depthSymbol && candleManager) {
            candleManager.unsubscribeDepth(depthSymbol)
          }
        }
      } catch {}
    })

    ws.on('close', () => {
      // Unsubscribe from all channels on disconnect
      if (candleManager) {
        for (const channel of client.subscriptions) {
          const candleInfo = parseCandleChannel(channel)
          if (candleInfo) candleManager.unsubscribeCandle(candleInfo.symbol, candleInfo.tf)
          const depthSymbol = parseDepthChannel(channel)
          if (depthSymbol) candleManager.unsubscribeDepth(depthSymbol)
        }
      }
      clients.delete(ws)
    })
  })
}

export function broadcast(msg: WsMessage) {
  const raw = JSON.stringify(msg)
  const channel = msg.channel || msg.type
  for (const [, client] of clients) {
    if (client.subscriptions.has(channel) || msg.type === 'ticker' || msg.type === 'alert' || msg.type === 'listing') {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw)
      }
    }
  }
}

export function broadcastToChannel(channel: string, data: unknown) {
  // Buffer into batch buffer instead of immediate send
  wsBatchBuffer.set(channel, data)
}
