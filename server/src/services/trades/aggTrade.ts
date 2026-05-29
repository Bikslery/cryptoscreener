import WebSocket from 'ws'
import { broadcastToChannel } from '../../ws/hub.js'
import { getWsAgent } from '../exchanges/proxy.js'

const AGGTRADE_WS_BASE = 'wss://stream.binance.com:9443'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const activeSymbols = new Set<string>()
let isConnecting = false

function connect() {
  if (activeSymbols.size === 0 || isConnecting) return
  isConnecting = true

  const streams = Array.from(activeSymbols).map(s => `${s.toLowerCase()}@aggTrade`).join('/')
  const url = `${AGGTRADE_WS_BASE}/stream?streams=${streams}`
  const agent = getWsAgent()
  const opts = agent ? { agent } : undefined

  console.log(`[AggTrade] Connecting to ${activeSymbols.size} symbols...`)

  ws = new WebSocket(url, opts)

  ws.on('open', () => {
    console.log('[AggTrade] WebSocket connected')
    isConnecting = false
  })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      const data = msg.data || msg
      if (data.e === 'aggTrade') {
        const symbol = data.s.toUpperCase()
        const price = parseFloat(data.p)
        const volume = parseFloat(data.q)
        const isBuyerMaker = data.m

        broadcastToChannel(`trade:${symbol}`, {
          symbol,
          price,
          volume,
          time: data.T / 1000,
          isBuyerMaker,
        })
      }
    } catch (e) {
      console.error('[AggTrade] Parse error:', e)
    }
  })

  ws.on('error', (err) => {
    console.error('[AggTrade] WebSocket error:', err.message)
    isConnecting = false
  })

  ws.on('close', () => {
    console.log('[AggTrade] WebSocket closed, reconnecting in 3s...')
    isConnecting = false
    scheduleReconnect()
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 3000)
}

function scheduleReconnectDebounced() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (ws) {
      try { ws.close() } catch {}
      ws = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    connect()
  }, 500)
}

export function subscribeAggTrade(symbol: string) {
  const wasEmpty = activeSymbols.size === 0
  activeSymbols.add(symbol)
  if (wasEmpty || !ws || ws.readyState !== WebSocket.OPEN) {
    scheduleReconnectDebounced()
  }
}

export function unsubscribeAggTrade(symbol: string) {
  activeSymbols.delete(symbol)
  if (activeSymbols.size === 0) {
    if (ws) {
      try { ws.close() } catch {}
      ws = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  } else {
    scheduleReconnectDebounced()
  }
}
