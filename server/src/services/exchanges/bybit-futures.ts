import WebSocket from 'ws'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'
import { fetchWithTimeout } from '../../utils/fetch.js'

const TF_MAP: Record<string, string> = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W',
}

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 60_000
const PING_INTERVAL_MS = 20_000
// Any inbound frame (ticker push, pong, sub ack) proves the socket is alive.
// Bybit does not always answer a stuck socket with a close event, so a
// silence watchdog terminates it and lets the reconnect logic take over.
const SILENCE_KILL_MS = 45_000
const SILENCE_CHECK_MS = 15_000
// Bybit public REST guidance is ~10 req/s per IP. A serial slot with a min
// gap keeps bursts (history stitching, metrics passes) polite — Bybit does
// not echo used-weight headers, so a Binance-style header limiter is not an
// option here.
const REST_MIN_INTERVAL_MS = 110

interface BybitTickerRaw {
  symbol?: string
  lastPrice?: string
  prevPrice24h?: string
  highPrice24h?: string
  lowPrice24h?: string
  volume24h?: string
  turnover24h?: string
}

interface BybitCandleRaw {
  start?: number
  open?: string
  high?: string
  low?: string
  close?: string
  volume?: string
  confirm?: boolean
  symbol?: string
}

type BybitDepthLevel = Array<string | number>

interface BybitDepthRaw {
  s?: string
  b?: BybitDepthLevel[]
  a?: BybitDepthLevel[]
  bids?: BybitDepthLevel[]
  asks?: BybitDepthLevel[]
}

export class BybitFuturesAdapter implements ExchangeAdapter {
  name = 'Bybit Futures'
  type: 'spot' | 'futures' = 'futures'
  exchange: Exchange = 'bybit-futures'

  private ws: WebSocket | null = null
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private depthSubs = new Map<string, Set<DepthCallback>>()
  private bookTickerCbs: Array<(symbol: string, midPrice: number) => void> = []
  private bookTickerSubs = new Set<string>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private instrumentsTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = RECONNECT_BASE_MS
  private instrumentsRetryDelay = 5_000
  private lastMsgAt = 0
  private subscribedSymbols = new Set<string>()
  private candleSubs = new Map<string, CandleCallback>()
  private precisionMap = new Map<string, number>()
  private intentionalClose = false
  private restQueue: Promise<unknown> = Promise.resolve()
  private restLastAt = 0

  // orderbook.200: 200 levels per side, pushed at 100ms — deep enough for
  // density clustering (±several % of mid on liquid pairs) without the
  // 500-level payload cost.
  private static readonly DEPTH_DEPTH = 200

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }
  onBookTicker(cb: (symbol: string, midPrice: number) => void) { this.bookTickerCbs.push(cb) }

  /** Serialize REST calls with a minimum gap (~9 req/s) across ALL Bybit
   *  endpoints — see REST_MIN_INTERVAL_MS. */
  private restSlot<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.restQueue.then(async () => {
      const wait = this.restLastAt + REST_MIN_INTERVAL_MS - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      this.restLastAt = Date.now()
      return fn()
    })
    this.restQueue = run.then(() => undefined, () => undefined)
    return run
  }

  subscribeBookTicker(symbol: string) {
    if (this.bookTickerSubs.has(symbol)) return
    this.bookTickerSubs.add(symbol)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: [`bookTicker.${symbol}`] }))
    }
  }

  unsubscribeBookTicker(symbol: string) {
    if (!this.bookTickerSubs.delete(symbol)) return
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [`bookTicker.${symbol}`] }))
    }
  }

  connect() {
    // Instruments are only needed once (precision per symbol); reconnects
    // keep the map. A failed first fetch is retried inside fetchInstruments.
    if (this.precisionMap.size === 0) this.fetchInstruments()
    const url = 'wss://stream.bybit.com/v5/public/linear'
    this.ws = new WebSocket(url)
    this.ws.on('open', () => {
      this.reconnectDelay = RECONNECT_BASE_MS
      this.lastMsgAt = Date.now()
      this.pingTimer = setInterval(() => {
        this.ws?.send(JSON.stringify({ op: 'ping' }))
      }, PING_INTERVAL_MS)
      this.silenceTimer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > SILENCE_KILL_MS && this.ws) {
          console.warn(`[${this.name}] WS silent for ${SILENCE_KILL_MS / 1000}s — terminating for reconnect`)
          this.ws.terminate()
        }
      }, SILENCE_CHECK_MS)
      this.subscribeAll()
    })
    this.ws.on('message', (raw) => {
      this.lastMsgAt = Date.now()
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.topic) {
          if (msg.topic.startsWith('tickers.')) {
            const ticker = this.parseTicker(msg.data)
            if (ticker) for (const cb of this.tickerCbs) cb(ticker)
          } else if (msg.topic.startsWith('kline.')) {
            const candle = this.parseCandle(msg.data, msg.topic)
            if (candle) {
              for (const cb of this.candleCbs) cb(candle)
              const subCb = this.candleSubs.get(msg.topic)
              if (subCb) subCb(candle)
            }
          } else if (msg.topic.startsWith('orderbook.')) {
            const depth = this.parseDepth(msg.data, msg.topic)
            if (depth) {
              for (const cb of this.depthCbs) cb(depth)
              const subs = this.depthSubs.get(depth.symbol)
              if (subs) for (const cb of subs) cb(depth)
            }
          } else if (msg.topic.startsWith('bookTicker.')) {
            // Best bid/ask — fires on every top-of-book change (dozens/sec on
            // liquid pairs), the same "live" price feed Binance bookTicker is.
            const d = msg.data
            const symbol = msg.topic.split('.').pop() || ''
            if (d && symbol && d.bp !== undefined && d.ap !== undefined) {
              const bid = parseFloat(String(d.bp))
              const ask = parseFloat(String(d.ap))
              if (isFinite(bid) && isFinite(ask) && bid > 0 && ask > 0) {
                const mid = (bid + ask) / 2
                for (const cb of this.bookTickerCbs) cb(symbol, mid)
              }
            }
          }
        }
      } catch {}
    })
    this.ws.on('close', () => this.scheduleReconnect())
    this.ws.on('error', () => this.scheduleReconnect())
  }

  private async fetchInstruments() {
    try {
      const res = await this.restSlot(() => fetchWithTimeout('https://api.bybit.com/v5/market/instruments-info?category=linear'))
      const json = await res.json()
      if (json.retCode !== 0 || !json.result?.list) throw new Error(`retCode=${json.retCode}`)
      for (const inst of json.result.list) {
        if (!inst.symbol?.endsWith('USDT')) continue
        const tickSize = inst.priceFilter?.tickSize
        if (tickSize) {
          this.precisionMap.set(inst.symbol, precisionFromTickSize(tickSize))
        }
      }
      if (this.precisionMap.size === 0) throw new Error('empty instrument list')
      this.instrumentsRetryDelay = 5_000
      console.log(`[${this.name}] Loaded precision for ${this.precisionMap.size} instruments`)
      this.subscribeAll()
    } catch (e) {
      // A failed instruments fetch used to leave precisionMap empty forever:
      // subscribeAll subscribed 0 tickers and the whole exchange silently
      // stayed dead. Retry with backoff until it lands.
      console.error(`[${this.name}] Failed to fetch instruments (retry in ${this.instrumentsRetryDelay / 1000}s):`, e instanceof Error ? e.message : e)
      const delay = this.instrumentsRetryDelay
      this.instrumentsRetryDelay = Math.min(this.instrumentsRetryDelay * 2, 120_000)
      this.instrumentsTimer = setTimeout(() => {
        this.instrumentsTimer = null
        this.fetchInstruments()
      }, delay)
    }
  }

  parseTicker(d: BybitTickerRaw): UnifiedTicker | null {
    const price = parseFloat(d.lastPrice ?? '')
    // Bybit ticker 'delta' messages can omit lastPrice (only changed fields) —
    // skip them instead of emitting NaN (which JSON-serializes to null and
    // made the price flicker to null in the UI).
    if (!isFinite(price) || price <= 0) return null
    const open = parseFloat(d.prevPrice24h ?? '') || price
    const pricePrecision = this.precisionMap.get(d.symbol ?? '') ?? fallbackPrecision(price)
    return {
      symbol: d.symbol ?? '',
      exchange: this.exchange,
      price,
      openPrice24h: open,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(d.highPrice24h ?? ''),
      low24h: parseFloat(d.lowPrice24h ?? ''),
      volume24h: parseFloat(d.volume24h ?? ''),
      trades24h: 0,
      quoteVolume24h: parseFloat(d.turnover24h ?? ''),
      range1m: 0,
      natr5m: 0,
      corrBtc: null,
      tradesSpike: null,
      volumeSpike: null,
      pricePrecision,
      timestamp: Date.now(),
    }
  }

  parseCandle(d: BybitCandleRaw | BybitCandleRaw[] | null, topic: string): UnifiedCandle | null {
    if (!d) return null
    const c = Array.isArray(d) ? d[0] : d
    const symbol = c.symbol || topic.split('.').pop() || ''
    const interval = topic.split('.')[1] || ''
    const timeframe = Object.entries(TF_MAP).find(([, v]) => v === interval)?.[0] || '5m'
    if (!symbol || !isFinite(c.start ?? NaN)) return null
    return {
      symbol,
      exchange: this.exchange,
      timeframe,
      time: (c.start ?? 0) / 1000,
      open: parseFloat(c.open ?? ''),
      high: parseFloat(c.high ?? ''),
      low: parseFloat(c.low ?? ''),
      close: parseFloat(c.close ?? ''),
      volume: parseFloat(c.volume ?? ''),
      isFinal: !!c.confirm,
    }
  }

  // Bybit allows up to 10 topics per subscribe message (1000 per connection).
  // Called on WS open (and after instruments load) so all tickers + any active
  // kline subscriptions are re-established after reconnects.
  private subscribeAll() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const args: string[] = []
    for (const symbol of this.precisionMap.keys()) args.push(`tickers.${symbol}`)
    for (const symbol of this.bookTickerSubs) args.push(`bookTicker.${symbol}`)
    for (const topic of this.candleSubs.keys()) args.push(topic)
    for (const symbol of this.depthSubs.keys()) args.push(`orderbook.${BybitFuturesAdapter.DEPTH_DEPTH}.${symbol}`)
    for (let i = 0; i < args.length; i += 10) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 10) }))
    }
    if (args.length > 0) {
      console.log(`[${this.name}] Subscribed ${args.length} topics (tickers + klines + depth)`)
    }
  }

  parseDepth(d: BybitDepthRaw, topic: string): UnifiedDepth | null {
    // orderbook.<depth>.<symbol> push: { s, b: [[price,size]..], a: [...], u, ts }
    const bids = d.bids ?? d.b
    const asks = d.asks ?? d.a
    if (!bids || !asks) return null
    const symbol = d.s || topic.split('.').pop() || ''
    return {
      symbol,
      exchange: this.exchange,
      bids: bids.map((b) => [parseFloat(String(b[0])), parseFloat(String(b[1]))]),
      asks: asks.map((a) => [parseFloat(String(a[0])), parseFloat(String(a[1]))]),
      timestamp: Date.now(),
    }
  }

  subscribeCandle(symbol: string, tf: string, cb: CandleCallback) {
    const interval = TF_MAP[tf]
    // Bybit futures has no second klines — refusing beats silently
    // subscribing to a 5-minute stream under a 1s label.
    if (!interval) return
    const topic = `kline.${interval}.${symbol}`
    this.candleSubs.set(topic, cb)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }))
    }
  }

  unsubscribeCandle(symbol: string, tf: string) {
    const interval = TF_MAP[tf]
    if (!interval) return
    const topic = `kline.${interval}.${symbol}`
    this.candleSubs.delete(topic)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }))
    }
  }

  subscribeDepth(symbol: string, cb: DepthCallback) {
    let set = this.depthSubs.get(symbol)
    if (!set) {
      set = new Set()
      this.depthSubs.set(symbol, set)
      const topic = `orderbook.${BybitFuturesAdapter.DEPTH_DEPTH}.${symbol}`
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }))
      }
    }
    set.add(cb)
  }

  unsubscribeDepth(symbol: string, cb?: DepthCallback) {
    const set = this.depthSubs.get(symbol)
    if (set && cb) set.delete(cb)
    if (!set || set.size === 0) {
      this.depthSubs.delete(symbol)
      const topic = `orderbook.${BybitFuturesAdapter.DEPTH_DEPTH}.${symbol}`
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }))
      }
    }
  }

  disconnect() {
    this.intentionalClose = true
    this.ws?.close()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    if (this.instrumentsTimer) clearTimeout(this.instrumentsTimer)
  }

  async fetchCandles(symbol: string, tf: string, limit: number, startTime?: number, endTime?: number): Promise<UnifiedCandle[]> {
    const interval = TF_MAP[tf]
    if (!interval) return []
    const params = new URLSearchParams({
      category: 'linear',
      symbol,
      interval,
      limit: String(Math.max(1, Math.min(limit, 1000))),
    })
    // startTime/endTime are milliseconds (the convention used by the Binance
    // adapters and the history/stitching layer). Bybit expects `start`/`end`
    // in ms too. Without them Bybit silently returns the LATEST candles —
    // which corrupted cross-exchange history stitching (it reads
    // candles[0] as the OLDEST row of the requested window).
    if (startTime !== undefined) params.set('start', String(startTime))
    if (endTime !== undefined) params.set('end', String(endTime))
    const url = `https://api.bybit.com/v5/market/kline?${params.toString()}`
    const res = await this.restSlot(() => fetchWithTimeout(url))
    const json = await res.json()
    if (json.retCode !== 0 || !json.result?.list) return []
    // Bybit returns rows newest-first; every other adapter (and the history
    // stitcher) expects ascending order.
    return json.result.list
      .map((k: unknown[]) => ({
        symbol,
        exchange: this.exchange,
        timeframe: tf,
        time: Number(k[0]) / 1000,
        open: parseFloat(String(k[1])),
        high: parseFloat(String(k[2])),
        low: parseFloat(String(k[3])),
        close: parseFloat(String(k[4])),
        volume: parseFloat(String(k[5])),
      }))
      .reverse()
  }

  async fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth> {
    const url = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${limit}`
    const res = await this.restSlot(() => fetchWithTimeout(url))
    const json = await res.json()
    if (json.retCode !== 0 || !json.result) {
      return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() }
    }
    return {
      symbol,
      exchange: this.exchange,
      bids: json.result.bids.map((b: unknown[]) => [parseFloat(String(b[0])), parseFloat(String(b[1]))]),
      asks: json.result.asks.map((a: unknown[]) => [parseFloat(String(a[0])), parseFloat(String(a[1]))]),
      timestamp: Date.now(),
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose) return
    if (this.reconnectTimer) return
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    // Exponential backoff: a fixed fast loop keeps hammering Bybit's
    // connection limiter after repeated drops. Reset on successful open.
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    console.log(`[${this.name}] WS closed, reconnecting in ${Math.round(delay / 1000)}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
