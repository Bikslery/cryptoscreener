import WebSocket from 'ws'
import type { Agent } from 'http'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'
import { BinanceRateLimiter } from './rate-limiter.js'
import { WsStreamPool } from './ws-pool.js'
import { getWsAgent, getFetchDispatcher } from './proxy.js'
import type { ProxyAgent } from 'undici'

const WS_SILENCE_TIMEOUT = 30_000
const MAX_KLINES_LIMIT = 1000

async function fetchWithTimeout(url: string, ms = 10000, dispatcher?: ProxyAgent): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const opts: RequestInit & { dispatcher?: ProxyAgent } = { signal: ctrl.signal }
    if (dispatcher) opts.dispatcher = dispatcher
    const res = await fetch(url, opts as RequestInit)
    return res
  } finally {
    clearTimeout(timer)
  }
}

const TF_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w',
}

const STABLECOIN_BASES = new Set([
  'USDC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'EUR', 'AEUR', 'EURI', 'USDSB', 'PYUSD',
])

const TICKER_WS_URL = 'wss://fstream.binance.com/ws/!miniTicker@arr'
const TICKER_REST_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr'
const TICKER_WS_PING_INTERVAL = 20_000
const TICKER_WS_RECONNECT_BASE = 1000
const TICKER_WS_RECONNECT_MAX = 60_000

export class BinanceFuturesAdapter implements ExchangeAdapter {
  name = 'Binance Futures'
  type: 'spot' | 'futures' = 'futures'
  exchange: Exchange = 'binance-futures'

  private tickerWs: WebSocket | null = null
  private tickerWsPingTimer: ReturnType<typeof setInterval> | null = null
  private tickerWsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private tickerWsReconnectDelay = TICKER_WS_RECONNECT_BASE
  private tickerWsIntentionalClose = false
  private tickerWsSilenceTimer: ReturnType<typeof setTimeout> | null = null
  private tickerWsReceivedData = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private usingRestFallback = false
  private candleSubs = new Map<string, CandleCallback>()
  private depthSubs = new Map<string, DepthCallback>()
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private precisionMap = new Map<string, number>()
  private cryptoSymbols = new Set<string>()
  private exchangeInfoLoaded = false
  private rateLimiter = new BinanceRateLimiter('futures')
  private wsAgent: Agent | undefined
  private fetchDispatcher: ProxyAgent | undefined

  private candlePool: WsStreamPool
  private depthPool: WsStreamPool

  constructor() {
    this.wsAgent = getWsAgent()
    this.fetchDispatcher = getFetchDispatcher()

    this.candlePool = new WsStreamPool(
      'wss://fstream.binance.com/stream',
      'Binance Futures Candle',
      (msg) => {
        try {
          const candle = this.parseCandle(msg)
          if (candle) {
            for (const cb of this.candleCbs) cb(candle)
            const subCb = this.candleSubs.get(msg.stream)
            if (subCb) subCb(candle)
          }
        } catch (e) {
          console.error('[Binance Futures] Candle parse error:', e)
        }
      },
      this.wsAgent,
      true  // supportsIncrementalSub
    )

    this.depthPool = new WsStreamPool(
      'wss://fstream.binance.com/stream',
      'Binance Futures Depth',
      (msg) => {
        try {
          const depth = this.parseDepth(msg)
          if (depth) {
            for (const cb of this.depthCbs) cb(depth)
          }
        } catch {}
      },
      this.wsAgent,
      true  // supportsIncrementalSub
    )
  }

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }

  connect() {
    this.fetchExchangeInfo().then(() => {
      this.connectTickerWs()
    })
    console.log(`[${this.name}] Connected (WebSocket !miniTicker@arr)`)
  }

  private async fetchExchangeInfo() {
    await this.rateLimiter.waitIfThrottled()
    try {
      const res = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/exchangeInfo', 10000, this.fetchDispatcher)
      this.rateLimiter.updateFromHeaders(res.headers)
      if (res.status === 429) { this.rateLimiter.handle429(res.headers); return }
      if (res.status === 418) { this.rateLimiter.handle418(res.headers); return }
      if (!res.ok) { this.rateLimiter.recordError(); return }
      const data = await res.json()
      if (!data.symbols || !Array.isArray(data.symbols)) { this.rateLimiter.recordError(); return }
      let filtered = 0
      for (const s of data.symbols) {
        if (!s.symbol.endsWith('USDT')) continue
        if (s.underlyingType === 'INDEX') { filtered++; continue }
        if (s.contractType !== 'PERPETUAL') { filtered++; continue }
        if (STABLECOIN_BASES.has(s.symbol.slice(0, -4))) { filtered++; continue }
        this.cryptoSymbols.add(s.symbol)
        for (const f of s.filters || []) {
          if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
            this.precisionMap.set(s.symbol, precisionFromTickSize(f.tickSize))
            break
          }
        }
      }
      this.exchangeInfoLoaded = true
      this.rateLimiter.recordSuccess()
      console.log(`[${this.name}] Loaded ${this.cryptoSymbols.size} crypto symbols (filtered ${filtered} index/non-perp entries)`)
    } catch (e) {
      this.rateLimiter.recordError()
      console.error(`[${this.name}] Failed to fetch exchangeInfo:`, e)
    }
  }

  private wsOpts(): WebSocket.ClientOptions | undefined {
    return this.wsAgent ? { agent: this.wsAgent } : undefined
  }

  private connectTickerWs() {
    this.tickerWsIntentionalClose = false
    if (this.tickerWs && this.tickerWs.readyState !== WebSocket.CLOSED && this.tickerWs.readyState !== WebSocket.CLOSING) {
      this.tickerWsIntentionalClose = true
      try { this.tickerWs.close() } catch {}
    }

    console.log(`[${this.name}] Ticker WS connecting...`)
    this.tickerWsReceivedData = false
    this.tickerWs = new WebSocket(TICKER_WS_URL, this.wsOpts())

    this.tickerWs.on('open', () => {
      console.log(`[${this.name}] Ticker WS connected (!miniTicker@arr)`)
      this.tickerWsReconnectDelay = TICKER_WS_RECONNECT_BASE
      if (this.usingRestFallback) {
        this.usingRestFallback = false
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
        console.log(`[${this.name}] Switched from REST fallback back to WS`)
      }
      this.tickerWsPingTimer = setInterval(() => {
        if (this.tickerWs?.readyState === WebSocket.OPEN) {
          this.tickerWs.ping()
        }
      }, TICKER_WS_PING_INTERVAL)

      this.tickerWsSilenceTimer = setTimeout(() => {
        if (!this.tickerWsReceivedData) {
          console.warn(`[${this.name}] WS silent for ${WS_SILENCE_TIMEOUT / 1000}s — likely blocked in this region, switching to REST polling`)
          this.tickerWsIntentionalClose = true
          this.tickerWs?.close()
          this.tickerWs = null
          this.startRestFallback()
        }
      }, WS_SILENCE_TIMEOUT)
    })

    this.tickerWs.on('message', (raw) => {
      this.tickerWsReceivedData = true
      if (this.tickerWsSilenceTimer) { clearTimeout(this.tickerWsSilenceTimer); this.tickerWsSilenceTimer = null }
      try {
        const arr = JSON.parse(raw.toString())
        if (!Array.isArray(arr)) return
        this.processTickerArray(arr)
      } catch (e) {
        console.error(`[${this.name}] Ticker WS parse error:`, e instanceof Error ? e.message : e)
      }
    })

    this.tickerWs.on('pong', () => {})

    this.tickerWs.on('error', (err) => {
      console.error(`[${this.name}] Ticker WS error:`, err.message || err)
    })

    this.tickerWs.on('close', () => {
      if (this.tickerWsPingTimer) { clearInterval(this.tickerWsPingTimer); this.tickerWsPingTimer = null }
      if (this.tickerWsSilenceTimer) { clearTimeout(this.tickerWsSilenceTimer); this.tickerWsSilenceTimer = null }
      if (this.tickerWsIntentionalClose) {
        this.tickerWsIntentionalClose = false
        return
      }
      console.warn(`[${this.name}] Ticker WS closed unexpectedly, falling back to REST, WS reconnect in ${this.tickerWsReconnectDelay}ms`)
      this.startRestFallback()
      this.tickerWsReconnectTimer = setTimeout(() => {
        this.tickerWsReconnectTimer = null
        this.tickerWsReconnectDelay = Math.min(this.tickerWsReconnectDelay * 2, TICKER_WS_RECONNECT_MAX)
        this.connectTickerWs()
      }, this.tickerWsReconnectDelay)
    })
  }

  private startRestFallback() {
    if (this.usingRestFallback) return
    this.usingRestFallback = true
    this.pollTickers()
    this.pollTimer = setInterval(() => this.pollTickers(), 3000)
  }

  private processTickerArray(arr: any[]) {
    for (const t of arr) {
      const symbol = t.s || t.symbol
      if (!symbol?.endsWith('USDT')) continue
      if (this.exchangeInfoLoaded && !this.cryptoSymbols.has(symbol)) continue
      const ticker = this.parseTicker(t)
      for (const cb of this.tickerCbs) cb(ticker)
    }
  }

  private async pollTickers() {
    if (this.rateLimiter.isThrottled()) return
    if (this.rateLimiter.isOverThreshold()) {
      console.warn(`[${this.name}] Skipping ticker poll — weight at ${this.rateLimiter.getWeight()}/${this.rateLimiter.getLimit()}`)
      return
    }
    try {
      const res = await fetchWithTimeout(TICKER_REST_URL, 10000, this.fetchDispatcher)
      this.rateLimiter.updateFromHeaders(res.headers)
      if (res.status === 429) { this.rateLimiter.handle429(res.headers); return }
      if (res.status === 418) { this.rateLimiter.handle418(res.headers); return }
      if (!res.ok) { this.rateLimiter.recordError(); return }
      const arr = await res.json()
      if (!Array.isArray(arr)) {
        console.warn(`[${this.name}] Ticker REST response not an array:`, JSON.stringify(arr).slice(0, 200))
        this.rateLimiter.recordError()
        return
      }
      this.rateLimiter.recordSuccess()
      this.processTickerArray(arr)
    } catch (e) {
      this.rateLimiter.recordError()
      console.error(`[${this.name}] Ticker poll error:`, e instanceof Error ? e.message : e)
    }
  }

  private parseTicker(t: any): UnifiedTicker {
    const isWs = !!t.s
    const symbol = isWs ? t.s : t.symbol
    const price = parseFloat(isWs ? t.c : t.lastPrice)
    const open = parseFloat(isWs ? t.o : t.openPrice)
    const pricePrecision = this.precisionMap.get(symbol) ?? fallbackPrecision(price)
    return {
      symbol,
      exchange: this.exchange,
      price,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(isWs ? t.h : t.highPrice),
      low24h: parseFloat(isWs ? t.l : t.lowPrice),
      volume24h: parseFloat(isWs ? t.v : t.volume),
      trades24h: parseInt(isWs ? (t.n ?? '0') : t.count),
      quoteVolume24h: parseFloat(isWs ? t.q : t.quoteVolume),
      range1m: 0,
      natr5m: 0,
      pricePrecision,
      timestamp: Date.now(),
    }
  }

  disconnect() {
    this.tickerWsIntentionalClose = true
    this.tickerWs?.close()
    if (this.tickerWsPingTimer) clearInterval(this.tickerWsPingTimer)
    if (this.tickerWsReconnectTimer) clearTimeout(this.tickerWsReconnectTimer)
    if (this.tickerWsSilenceTimer) clearTimeout(this.tickerWsSilenceTimer)
    this.candlePool.close()
    this.depthPool.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
  }

  subscribeCandle(symbol: string, tf: string, cb: CandleCallback) {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[tf] || '1m'}`
    this.candleSubs.set(stream, cb)
    this.candlePool.addStream(stream)
  }

  unsubscribeCandle(symbol: string, tf: string) {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[tf] || '1m'}`
    this.candleSubs.delete(stream)
    this.candlePool.removeStream(stream)
  }

  subscribeDepth(symbol: string, cb: DepthCallback) {
    const stream = `${symbol.toLowerCase()}@depth20@100ms`
    this.depthSubs.set(stream, cb)
    this.depthPool.addStream(stream)
  }

  unsubscribeDepth(symbol: string) {
    const stream = `${symbol.toLowerCase()}@depth20@100ms`
    this.depthSubs.delete(stream)
    this.depthPool.removeStream(stream)
  }

  private parseCandle(msg: any): UnifiedCandle | null {
    const k = msg.k || msg.data?.k
    if (!k) return null
    return {
      symbol: k.s,
      exchange: this.exchange,
      timeframe: k.i,
      time: k.t / 1000,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
    }
  }

  private parseDepth(msg: any): UnifiedDepth | null {
    const d = msg.data || msg
    if (!d.bids || !d.asks) return null
    return {
      symbol: d.s || '',
      exchange: this.exchange,
      bids: d.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: d.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: Date.now(),
    }
  }

  async fetchCandles(symbol: string, tf: string, limit: number, startTime?: number, endTime?: number, options?: import('./types.js').FetchCandlesOptions): Promise<UnifiedCandle[]> {
    const interval = TF_MAP[tf] || '1m'
    const safeLimit = Math.max(1, Math.min(limit, MAX_KLINES_LIMIT))
    const params = new URLSearchParams({ symbol, interval, limit: String(safeLimit) })
    if (startTime !== undefined) params.set('startTime', String(startTime))
    if (endTime !== undefined) params.set('endTime', String(endTime))
    const url = `https://fapi.binance.com/fapi/v1/klines?${params.toString()}`
    await this.rateLimiter.waitIfThrottled()
    try {
      const res = await fetchWithTimeout(url, 10000, options?.dispatcher ?? this.fetchDispatcher)
      this.rateLimiter.updateFromHeaders(res.headers)
      if (res.status === 429) { this.rateLimiter.handle429(res.headers); return [] }
      if (res.status === 418) { this.rateLimiter.handle418(res.headers); return [] }
      if (!res.ok) { this.rateLimiter.recordError(); return [] }
      const data = await res.json()
      if (!Array.isArray(data)) { this.rateLimiter.recordError(); return [] }
      this.rateLimiter.recordSuccess()
      return data.map((k: any[]) => ({
        symbol,
        exchange: this.exchange,
        timeframe: tf,
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }))
    } catch (e) {
      this.rateLimiter.recordError()
      throw e
    }
  }

  async fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth> {
    const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`
    await this.rateLimiter.waitIfThrottled()
    try {
      const res = await fetchWithTimeout(url, 10000, this.fetchDispatcher)
      this.rateLimiter.updateFromHeaders(res.headers)
      if (res.status === 429) { this.rateLimiter.handle429(res.headers); return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() } }
      if (res.status === 418) { this.rateLimiter.handle418(res.headers); return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() } }
      if (!res.ok) { this.rateLimiter.recordError(); return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() } }
      const data = await res.json()
      if (!data.bids || !data.asks) { this.rateLimiter.recordError(); return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() } }
      this.rateLimiter.recordSuccess()
      return {
        symbol,
        exchange: this.exchange,
        bids: data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
        timestamp: Date.now(),
      }
    } catch (e) {
      this.rateLimiter.recordError()
      throw e
    }
  }
}
