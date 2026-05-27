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

// Broadcast batching
const wsBatchBuffer = new Map<string, unknown>()

let batchTimer: ReturnType<typeof setInterval> | null = null

function flushBatchBuffer(): void {
  if (wsBatchBuffer.size === 0) return
  const entries = Array.from(wsBatchBuffer.entries())
  wsBatchBuffer.clear()
  for (const [channel, data] of entries) {
    const msg = { type: channel, channel, data } as WsMessage
    const raw = JSON.stringify(msg)
    for (const [, client] of clients) {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw)
      }
    }
  }
}

function startBatchTimer(): void {
  if (batchTimer) return
  batchTimer = setInterval(flushBatchBuffer, 100)
}

startBatchTimer()

function buildInitialCandlesData(): Record<string, any[]> {
  // Determine top-9 symbols: prefer cache-based, fall back to ticker-based
  let topSymbols: string[] = []
  const cached5m = getTopCachedSymbols('5m', 9)
  if (cached5m.length >= 9) {
    topSymbols = cached5m
  } else {
    // Fallback: sort tickers by quoteVolume24h
    const tickers = getTickers()
    topSymbols = tickers
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 9)
      .map(t => t.symbol)
  }

  const data: Record<string, any[]> = {}
  for (const symbol of topSymbols) {
    for (const tf of PRELOAD_TFS) {
      const candles = getCachedCandles(symbol, tf)
      if (candles && candles.length > 0) {
        const key = `${symbol}:${tf}`
        data[key] = candles.slice(candles.length - 300)
      }
    }
  }
  return data
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

    // Send initial-candles push immediately after connect
    try {
      const initialData = buildInitialCandlesData()
      if (Object.keys(initialData).length > 0) {
        const initMsg = { type: 'initial-candles', data: initialData }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(initMsg))
        }
      }
    } catch {}

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
  // Immediate broadcast for urgent messages (ticker, alert, listing)
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
  // Buffer for batched send (100ms flush)
  wsBatchBuffer.set(channel, data)
}
