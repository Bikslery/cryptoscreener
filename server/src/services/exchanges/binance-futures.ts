import WebSocket from 'ws'
import type { Agent } from 'http'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'
import { fetchWithTimeout } from '../../utils/fetch.js'
import { BinanceRateLimiter } from './rate-limiter.js'
import { WsStreamPool } from './ws-pool.js'
import { getWsAgent, getFetchDispatcher } from './proxy.js'
import type { ProxyAgent } from 'undici'

const WS_SILENCE_TIMEOUT = 30_000
const MAX_KLINES_LIMIT = 1000

const TF_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w',
}

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}

const CANDLE_WS_SILENCE_TIMEOUT = 10_000
const CANDLE_POLL_INTERVAL = 1_500

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
  private candleMsgCount = 0
  private lastCandleMsgAt = 0
  private candleFallbackActive = false
  private candleFallbackTimer: ReturnType<typeof setInterval> | null = null
  private candleSilenceTimer: ReturnType<typeof setInterval> | null = null
  private candleSubInfo = new Map<string, { symbol: string, tf: string }>()
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
            this.candleMsgCount++
            this.lastCandleMsgAt = Date.now()
            if (this.candleFallbackActive) {
              this.stopCandleFallback()
              console.log(`[${this.name}] Candle WS recovered → stop REST poll`)
            }
            if (this.candleMsgCount <= 3 || this.candleMsgCount % 200 === 0) {
              console.log(`[BinanceFutures] kline #${this.candleMsgCount}: ${candle.symbol} ${candle.timeframe} close=${candle.close}`)
            }
            for (const cb of this.candleCbs) cb(candle)
            const subCb = this.candleSubs.get(msg.stream)
            if (subCb) subCb(candle)
          }
        } catch (e) {
          console.error('[Binance Futures] Candle parse error:', e)
        }
      },
      this.wsAgent,
      true
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
  getRateLimiter() { return this.rateLimiter }

  connect() {
    this.rateLimiter.probeWeight(this.fetchDispatcher).then(() => {
      this.fetchExchangeInfo().then(() => {
        this.connectTickerWs()
      })
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
      openPrice24h: open,
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
    this.stopCandleSilenceChecker()
    this.stopCandleFallback()
  }

  subscribeCandle(symbol: string, tf: string, cb: CandleCallback) {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[tf] || '1m'}`
    this.candleSubs.set(stream, cb)
    this.candleSubInfo.set(stream, { symbol, tf })
    this.candlePool.addStream(stream)
    console.log(`[BinanceFutures] subscribeCandle: ${stream} (pool streams=${this.candlePool.size})`)
    if (this.candleSubs.size === 1) {
      this.lastCandleMsgAt = Date.now()
      this.startCandleSilenceChecker()
      this.startCandleFallback()
    }
  }

  unsubscribeCandle(symbol: string, tf: string) {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[tf] || '1m'}`
    this.candleSubs.delete(stream)
    this.candleSubInfo.delete(stream)
    this.candlePool.removeStream(stream)
    if (this.candleSubs.size === 0) {
      this.stopCandleSilenceChecker()
      this.stopCandleFallback()
    }
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

  private startCandleSilenceChecker() {
    if (this.candleSilenceTimer) return
    this.candleSilenceTimer = setInterval(() => {
      if (this.candleSubs.size === 0 || this.candleFallbackActive) return
      if (Date.now() - this.lastCandleMsgAt > CANDLE_WS_SILENCE_TIMEOUT) {
        console.warn(`[${this.name}] Candle WS silent for ${CANDLE_WS_SILENCE_TIMEOUT / 1000}s → REST-poll fallback`)
        this.startCandleFallback()
      }
    }, 2_000)
  }

  private stopCandleSilenceChecker() {
    if (this.candleSilenceTimer) { clearInterval(this.candleSilenceTimer); this.candleSilenceTimer = null }
  }

  private startCandleFallback() {
    if (this.candleFallbackActive) return
    this.candleFallbackActive = true
    this.pollCandleFallback()
    this.candleFallbackTimer = setInterval(() => this.pollCandleFallback(), CANDLE_POLL_INTERVAL)
  }

  private stopCandleFallback() {
    this.candleFallbackActive = false
    if (this.candleFallbackTimer) { clearInterval(this.candleFallbackTimer); this.candleFallbackTimer = null }
  }

  private async pollCandleFallback() {
    if (this.rateLimiter.isThrottled()) return
    if (this.rateLimiter.isOverThreshold()) return
    const entries = Array.from(this.candleSubInfo.entries())
    if (entries.length === 0) return
    const nowSec = Date.now() / 1000
    const results = await Promise.allSettled(entries.map(async ([stream, { symbol, tf }]) => {
      const tfSec = TF_SECONDS[tf] || 60
      try {
        const candles = await this.fetchCandles(symbol, tf, 2)
        for (const c of candles) {
          const subCb = this.candleSubs.get(stream)
          const candle: UnifiedCandle = {
            ...c,
            isFinal: c.time + tfSec <= nowSec,
          }
          if (subCb) subCb(candle)
          for (const cb of this.candleCbs) cb(candle)
        }
      } catch {}
    }))
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) {
      console.warn(`[${this.name}] Candle REST-poll: ${failed}/${entries.length} failed`)
    }
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
      isFinal: !!k.x,
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
