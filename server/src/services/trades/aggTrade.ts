import WebSocket from 'ws'
import { broadcastToChannel } from '../../ws/hub.js'
import { getWsAgent } from '../exchanges/proxy.js'
import { FUTURES_AGGTRADE_WS_BASE, SPOT_WS_BASE } from '../exchanges/endpoints.js'
import { updateTickerPrice, recordTradeBucket } from '../aggregator/index.js'
import { getRedisPub, REDIS_ENABLED } from '../../redis.js'
import type { Exchange, UnifiedTrade } from '../../types.js'

/** Verbose per-message progress logs — opt-in via env (same flag as candle manager). */
const DIAG_LOG = process.env.DIAG_LOG === '1'

interface AggTradeStream {
  ws: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  activeSymbols: Set<string>
  isConnecting: boolean
  generation: number
  reqId: number
  msgCount: number
}

// --- Trade-lane coalescing ---------------------------------------------------
// Active symbols print dozens of aggTrades/sec; broadcasting EVERY print as
// its own immediate WS frame flooded the client (per trade: 1 trade frame +
// 1 kline frame), so the browser's serial parse queue backed up and the
// chart visibly fell behind the real стакан. Instead, per (exchange, symbol)
// the LATEST trade is flushed every TRADE_LANE_INTERVAL_MS — latest price +
// latest time for the forming candle (latest-wins) and the window's SUMMED
// base volume.
interface PendingTrade {
  symbol: string
  exchange: Exchange
  price: number
  volume: number
  time: number
  eventTimeMs: number
  isBuyerMaker: boolean
  tradeId?: string
  sequence?: string
}

const TRADE_LANE_INTERVAL_MS = parseInt(process.env.TRADE_LANE_INTERVAL_MS || '30', 10)
const pendingTrades = new Map<string, PendingTrade>()
let tradeFlushTimer: ReturnType<typeof setTimeout> | null = null

function queueTrade(symbol: string, exchange: Exchange, payload: PendingTrade): void {
  const key = `${exchange}:${symbol}`
  const prev = pendingTrades.get(key)
  if (prev) {
    // Latest-wins price/time; volume accumulates so nothing is lost.
    prev.price = payload.price
    prev.time = payload.time
    prev.eventTimeMs = payload.eventTimeMs
    prev.volume += payload.volume
    prev.isBuyerMaker = payload.isBuyerMaker
    prev.tradeId = payload.tradeId
    prev.sequence = payload.sequence
  } else {
    pendingTrades.set(key, { ...payload })
  }
  if (tradeFlushTimer === null) {
    tradeFlushTimer = setTimeout(flushPendingTrades, TRADE_LANE_INTERVAL_MS)
  }
}

function flushPendingTrades(): void {
  tradeFlushTimer = null
  for (const [key, t] of pendingTrades) {
    pendingTrades.delete(key)
    const payload = {
      symbol: t.symbol,
      exchange: t.exchange,
      price: t.price,
      volume: t.volume,
      time: t.time,
      eventTimeMs: t.eventTimeMs,
      isBuyerMaker: t.isBuyerMaker,
      tradeId: t.tradeId,
      sequence: t.sequence,
    }
    broadcastToChannel(`trade:${t.exchange}:${t.symbol}`, payload, true)
    if (REDIS_ENABLED) {
      try {
        getRedisPub().publish('trades', JSON.stringify(payload)).catch(() => {})
      } catch { /* redis down */ }
    }
  }
}

export function enqueueTrade(trade: UnifiedTrade): void {
  queueTrade(trade.symbol, trade.exchange, {
    ...trade,
    time: Math.floor(trade.eventTimeMs / 1000),
  })
}

/** Flush immediately (reconnect/teardown safety). */
export function flushTradeLane(): void {
  if (tradeFlushTimer !== null) {
    clearTimeout(tradeFlushTimer)
    tradeFlushTimer = null
  }
  flushPendingTrades()
}

function createStream(): AggTradeStream {
  return {
    ws: null,
    reconnectTimer: null,
    debounceTimer: null,
    activeSymbols: new Set(),
    isConnecting: false,
    generation: 0,
    reqId: 0,
    msgCount: 0,
  }
}

// Binance combined-stream URLs are capped at 8192 chars (~500 streams) while
// spot alone has ~700 USDT pairs, so split subscriptions across several WS
// connections. Each chunk stays well under the per-connection limits.
const CHUNK_SIZE = 250

const spotChunks: AggTradeStream[] = []
const futuresChunks: AggTradeStream[] = []
const symbolToChunk = new Map<string, AggTradeStream>()

function getChunks(exchange: Exchange): AggTradeStream[] {
  return exchange === 'binance-futures' ? futuresChunks : spotChunks
}

function getChunkForSymbol(exchange: Exchange, symbol: string): AggTradeStream {
  const key = `${exchange}:${symbol}`
  const existing = symbolToChunk.get(key)
  if (existing) return existing
  const chunks = getChunks(exchange)
  let chunk = chunks.find(c => c.activeSymbols.size < CHUNK_SIZE)
  if (!chunk) {
    chunk = createStream()
    chunks.push(chunk)
  }
  symbolToChunk.set(key, chunk)
  return chunk
}

function getWsBase(exchange: Exchange): string {
  // Resolved centrally (see exchanges/endpoints.ts) so this lane and the
  // futures ticker/kline/depth lane can never disagree on the host — they used
  // to read the same env var with different hardcoded defaults, which meant a
  // regionally-blocked domain downgraded only the market-data lane to REST.
  return exchange === 'binance-futures' ? FUTURES_AGGTRADE_WS_BASE : SPOT_WS_BASE
}

function connect(stream: AggTradeStream, exchange: Exchange) {
  if (stream.activeSymbols.size === 0 || stream.isConnecting) return
  stream.isConnecting = true
  const generation = ++stream.generation

  const streams = Array.from(stream.activeSymbols).map(s => `${s.toLowerCase()}@aggTrade`).join('/')
  const url = `${getWsBase(exchange)}/stream?streams=${streams}`
  const agent = getWsAgent()
  const opts = agent && exchange === 'binance-futures' ? { agent } : undefined

  const label = exchange === 'binance-futures' ? 'Futures' : ''
  console.log(`[AggTrade${label}] Connecting to ${stream.activeSymbols.size} symbols...`)

  const nextWs = new WebSocket(url, opts)
  stream.ws = nextWs

  nextWs.on('open', () => {
    console.log(`[AggTrade${label}] WebSocket connected`)
    if (generation === stream.generation) {
      stream.isConnecting = false
      const urlSymbols = new Set(streams.split('/').map(s => s.replace('@aggTrade', '').toUpperCase()))
      const missing = Array.from(stream.activeSymbols).filter(s => !urlSymbols.has(s))
      if (missing.length > 0) {
        sendSubscribe(stream, exchange, missing)
      }
    }
  })

  nextWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      stream.msgCount++
      // Per-500-messages progress logs spam hard on busy trade streams —
      // keep them behind DIAG_LOG=1.
      if (DIAG_LOG && (stream.msgCount <= 3 || stream.msgCount % 500 === 0)) {
        console.log(`[AggTrade${label}] msg #${stream.msgCount} stream=${msg.stream ?? 'ctrl'}`)
      }
      const data = msg.data || msg
      if (data.e === 'aggTrade') {
        const symbol = data.s.toUpperCase()
        const price = parseFloat(data.p)
        const volume = parseFloat(data.q)
        const isBuyerMaker = data.m

        updateTickerPrice(symbol, exchange, price)

        // 5m trade-count bucket for the tradesSpike indicator (Binance only —
        // Bybit/OKX trade lanes are not Binance aggTrade streams).
        recordTradeBucket(symbol, data.T)

        const tradePayload: UnifiedTrade = {
          symbol,
          exchange,
          price,
          volume,
          eventTimeMs: data.T,
          isBuyerMaker,
          tradeId: String(data.a ?? ''),
        }

        // Coalesced latest-wins broadcast — the chart needs the newest price
        // (not every print). This cuts the per-trade frame flood that
        // saturated the client's parse queue.
        enqueueTrade(tradePayload)
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

function sendSubscribe(stream: AggTradeStream, exchange: Exchange, symbols: string[]) {
  if (!stream.ws || stream.ws.readyState !== WebSocket.OPEN) return
  const params = symbols.map(s => `${s.toLowerCase()}@aggTrade`)
  stream.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: ++stream.reqId }))
  const label = exchange === 'binance-futures' ? 'Futures' : ''
  console.log(`[AggTrade${label}] SUBSCRIBE ${params.length} stream(s) on live WS (total: ${stream.activeSymbols.size})`)
}

function sendUnsubscribe(stream: AggTradeStream, exchange: Exchange, symbols: string[]) {
  if (!stream.ws || stream.ws.readyState !== WebSocket.OPEN) return
  const params = symbols.map(s => `${s.toLowerCase()}@aggTrade`)
  stream.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params, id: ++stream.reqId }))
  const label = exchange === 'binance-futures' ? 'Futures' : ''
  console.log(`[AggTrade${label}] UNSUBSCRIBE ${params.length} stream(s) on live WS (total: ${stream.activeSymbols.size})`)
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
  const stream = getChunkForSymbol(exchange, symbol)
  const isNew = !stream.activeSymbols.has(symbol)
  const wasEmpty = stream.activeSymbols.size === 0
  stream.activeSymbols.add(symbol)
  if (wasEmpty || !stream.ws || stream.ws.readyState !== WebSocket.OPEN) {
    scheduleReconnectDebounced(stream, exchange)
  } else if (isNew) {
    sendSubscribe(stream, exchange, [symbol])
  }
}

export function unsubscribeAggTrade(symbol: string, exchange: Exchange = 'binance-spot') {
  // Guard against a stray double-unsubscribe: getChunkForSymbol() would
  // otherwise create a fresh chunk just so we could tear it down again.
  const stream = symbolToChunk.get(`${exchange}:${symbol}`)
  if (!stream) return
  stream.activeSymbols.delete(symbol)
  if (stream.activeSymbols.size === 0) {
    // Chunk is empty — tear the socket down AND drop its symbolToChunk entry:
    // without this the Map grew one AggTradeStream per touched chunk forever
    // (socket refs, timers, sets) across weeks of subscribe/unsubscribe churn.
    symbolToChunk.delete(`${exchange}:${symbol}`)
    const chunks = getChunks(exchange)
    const idx = chunks.indexOf(stream)
    if (idx >= 0) chunks.splice(idx, 1)
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
  } else if (stream.ws && stream.ws.readyState === WebSocket.OPEN) {
    sendUnsubscribe(stream, exchange, [symbol])
  } else {
    scheduleReconnectDebounced(stream, exchange)
  }
}
