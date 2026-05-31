import WebSocket from 'ws'
import { broadcastToChannel } from '../../ws/hub.js'
import { getWsAgent } from '../exchanges/proxy.js'
import { updateTickerPrice } from '../aggregator/index.js'
import type { Exchange } from '../../types.js'

interface AggTradeStream {
  ws: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  activeSymbols: Set<string>
  isConnecting: boolean
  generation: number
}

function createStream(): AggTradeStream {
  return {
    ws: null,
    reconnectTimer: null,
    debounceTimer: null,
    activeSymbols: new Set(),
    isConnecting: false,
    generation: 0,
  }
}

const spotStream = createStream()
const futuresStream = createStream()

function getStream(exchange: Exchange): AggTradeStream {
  return exchange === 'binance-futures' ? futuresStream : spotStream
}

function getWsBase(exchange: Exchange): string {
  return exchange === 'binance-futures'
    ? 'wss://fstream.binance.com'
    : 'wss://stream.binance.com:9443'
}

function connect(stream: AggTradeStream, exchange: Exchange) {
  if (stream.activeSymbols.size === 0 || stream.isConnecting) return
  stream.isConnecting = true
  const generation = ++stream.generation

  const streams = Array.from(stream.activeSymbols).map(s => `${s.toLowerCase()}@aggTrade`).join('/')
  const url = `${getWsBase(exchange)}/stream?streams=${streams}`
  const agent = getWsAgent()
  const opts = agent ? { agent } : undefined

  const label = exchange === 'binance-futures' ? 'Futures' : ''
  console.log(`[AggTrade${label}] Connecting to ${stream.activeSymbols.size} symbols...`)

  const nextWs = new WebSocket(url, opts)
  stream.ws = nextWs

  nextWs.on('open', () => {
    console.log(`[AggTrade${label}] WebSocket connected`)
    if (generation === stream.generation) stream.isConnecting = false
  })

  nextWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      const data = msg.data || msg
      if (data.e === 'aggTrade') {
        const symbol = data.s.toUpperCase()
        const price = parseFloat(data.p)
        const volume = parseFloat(data.q)
        const isBuyerMaker = data.m

        updateTickerPrice(symbol, exchange, price)

        broadcastToChannel(`trade:${symbol}`, {
          symbol,
          price,
          volume,
          time: data.T / 1000,
          isBuyerMaker,
        }, true)
      }
    } catch (e) {
      console.error(`[AggTrade${label}] Parse error:`, e)
    }
  })

  nextWs.on('error', (err) => {
    console.error(`[AggTrade${label}] WebSocket error:`, err.message)
    if (generation === stream.generation) stream.isConnecting = false
  })

  nextWs.on('close', () => {
    if (generation !== stream.generation) return
    console.log(`[AggTrade${label}] WebSocket closed, reconnecting in 3s...`)
    stream.isConnecting = false
    scheduleReconnect(stream, exchange)
  })
}

function scheduleReconnect(stream: AggTradeStream, exchange: Exchange) {
  if (stream.reconnectTimer) return
  stream.reconnectTimer = setTimeout(() => {
    stream.reconnectTimer = null
    connect(stream, exchange)
  }, 3000)
}

function scheduleReconnectDebounced(stream: AggTradeStream, exchange: Exchange) {
  if (stream.debounceTimer) {
    clearTimeout(stream.debounceTimer)
  }
  stream.debounceTimer = setTimeout(() => {
    stream.debounceTimer = null
    if (stream.ws) {
      stream.generation++
      stream.isConnecting = false
      try { stream.ws.close() } catch {}
      stream.ws = null
    }
    if (stream.reconnectTimer) {
      clearTimeout(stream.reconnectTimer)
      stream.reconnectTimer = null
    }
    connect(stream, exchange)
  }, 500)
}

export function subscribeAggTrade(symbol: string, exchange: Exchange = 'binance-spot') {
  const stream = getStream(exchange)
  const wasEmpty = stream.activeSymbols.size === 0
  stream.activeSymbols.add(symbol)
  if (wasEmpty || !stream.ws || stream.ws.readyState !== WebSocket.OPEN) {
    scheduleReconnectDebounced(stream, exchange)
  }
}

export function unsubscribeAggTrade(symbol: string, exchange: Exchange = 'binance-spot') {
  const stream = getStream(exchange)
  stream.activeSymbols.delete(symbol)
  if (stream.activeSymbols.size === 0) {
    if (stream.ws) {
      stream.generation++
      stream.isConnecting = false
      try { stream.ws.close() } catch {}
      stream.ws = null
    }
    if (stream.reconnectTimer) {
      clearTimeout(stream.reconnectTimer)
      stream.reconnectTimer = null
    }
    if (stream.debounceTimer) {
      clearTimeout(stream.debounceTimer)
      stream.debounceTimer = null
    }
  } else {
    scheduleReconnectDebounced(stream, exchange)
  }
}
