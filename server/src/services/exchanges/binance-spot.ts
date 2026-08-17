import WebSocket from 'ws'
import type { Agent } from 'http'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'
import { fetchWithTimeout } from '../../utils/fetch.js'
import { BinanceRateLimiter } from './rate-limiter.js'
import { RateLimitError, ExchangeRequestError } from './errors.js'
import { WsStreamPool } from './ws-pool.js'
import { BinanceDepthBook, type DiffDepthEvent } from './binance-depth-book.js'
import { withDepthSnapshotSlot } from './depth-snapshot-limiter.js'
import { getFetchDispatcher } from './proxy.js'
import type { ProxyAgent } from 'undici'

const WS_SILENCE_TIMEOUT = 30_000
const MAX_KLINES_LIMIT = 1000

const TF_MAP: Record<string, string> = {
  '1s': '1s', '5s': '5s', '15s': '15s', '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w',
}

const STABLECOIN_BASES = new Set([
  'USDC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'EUR', 'AEUR', 'EURI', 'USDSB', 'PYUSD',
])

interface BinanceTickerRaw {
  // WS miniTicker format
  s?: string
  c?: string
  o?: string
  h?: string
  l?: string
  v?: string
  n?: string
  q?: string
  // REST 24hr format
  symbol?: string
  lastPrice?: string
  openPrice?: string
  highPrice?: string
  lowPrice?: string
  volume?: string
  count?: number
  quoteVolume?: string
}

interface BinanceKline {
  s?: string
  i?: string
  t?: number
  o?: string
  h?: string
  l?: string
  c?: string
  v?: string
  x?: boolean
}

interface BinanceCandleMsg {
  k?: BinanceKline
  data?: { k?: BinanceKline }
}

type BinanceLevel = [string, string]

interface BinanceDepthDiffRaw {
  data?: BinanceDepthDiffRaw
  s?: string
  symbol?: string
  U?: number
  u?: number
  b?: BinanceLevel[]
  a?: BinanceLevel[]
}

const TICKER_WS_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr'
const TICKER_REST_URL = 'https://api.binance.com/api/v3/ticker/24hr'
const TICKER_WS_PING_INTERVAL = 20_000
const TICKER_WS_RECONNECT_BASE = 1000
const TICKER_WS_RECONNECT_MAX = 60_000

export class BinanceSpotAdapter implements ExchangeAdapter {
  name = 'Binance'
  type: 'spot' | 'futures' = 'spot'
  exchange: Exchange = 'binance-spot'

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
  private depthSubs = new Map<string, Set<DepthCallback>>()
  private depthBooks = new Map<string, BinanceDepthBook>()
  private depthStreams = new Set<string>()
  private depthBookLoading = new Set<string>()
  /** per-symbol reseed backoff (ms); doubles on each failed retry, caps at 2 min */
  private depthRetryDelay = new Map<string, number>()
  private lastDepthEmitAt = new Map<string, number>()
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private precisionMap = new Map<string, number>()
  private cryptoSymbols = new Set<string>()
  private exchangeInfoLoaded = false
  private rateLimiter = new BinanceRateLimiter('spot')
  private wsAgent: Agent | undefined
  private fetchDispatcher: ProxyAgent | undefined

  private candlePool: WsStreamPool
  private depthPool: WsStreamPool

  constructor() {
    this.fetchDispatcher = getFetchDispatcher()

    this.candlePool = new WsStreamPool(
      'wss://stream.binance.com:9443/stream',
      'Binance Candle',
      (msg) => {
        try {
          const candle = this.parseCandle(msg)
          if (candle) {
            for (const cb of this.candleCbs) cb(candle)
            const streamName = msg.stream || ''
            const subCb = this.candleSubs.get(streamName)
            if (subCb) subCb(candle)
          }
        } catch (e) {
          console.error('[Binance] Candle parse error:', e)
        }
      },
      this.wsAgent,
      true  // supportsIncrementalSub
    )

    this.depthPool = new WsStreamPool(
      'wss://stream.binance.com:9443/stream',
      'Binance Depth',
      (msg) => {
        try {
          const depth = this.handleDepthMsg(msg)
          if (depth) {
            for (const cb of this.depthCbs) cb(depth)
            const subs = this.depthSubs.get(depth.symbol)
            if (subs) for (const cb of subs) cb(depth)
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
      this.fetchExchangeInfo()
    })
    this.connectTickerWs()
    console.log(`[${this.name}] Connected (WebSocket !miniTicker@arr)`)
  }

  private async fetchExchangeInfo() {
    await this.rateLimiter.waitIfThrottled()
    try {
      const res = await fetchWithTimeout('https://api.binance.com/api/v3/exchangeInfo', 10000, this.fetchDispatcher)
      this.rateLimiter.updateFromHeaders(res.headers)
      if (res.status === 429) { this.rateLimiter.handle429(res.headers); return }
      if (res.status === 418) { this.rateLimiter.handle418(res.headers); return }
      if (!res.ok) { this.rateLimiter.recordError(); return }
      const data = await res.json()
      if (!data.symbols || !Array.isArray(data.symbols)) { this.rateLimiter.recordError(); return }
      let filtered = 0
      for (const s of data.symbols) {
        if (!s.symbol.endsWith('USDT')) continue
        // Skip pairs that are NOT actively trading (BREAK/PENDING_TRADING/
        // delisted etc.). The WS !miniTicker@arr still broadcasts stale stats
        // for them, which pushes them into the screener with empty charts.
        if (s.status && s.status !== 'TRADING') { filtered++; continue }
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
      console.log(`[${this.name}] Loaded ${this.cryptoSymbols.size} crypto symbols (filtered ${filtered} non-TRADING entries)`)
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

  processTickerArray(arr: BinanceTickerRaw[]) {
    for (const t of arr) {
      const symbol = t.s || t.symbol
      if (!symbol?.endsWith('USDT')) continue
      if (STABLECOIN_BASES.has(symbol.slice(0, -4))) continue
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

  parseTicker(t: BinanceTickerRaw): UnifiedTicker {
    const isWs = !!t.s
    const symbol = (isWs ? t.s : t.symbol) ?? ''
    const price = parseFloat((isWs ? t.c : t.lastPrice) ?? '')
    const open = parseFloat((isWs ? t.o : t.openPrice) ?? '')
    const pricePrecision = this.precisionMap.get(symbol) ?? fallbackPrecision(price)
    return {
      symbol,
      exchange: this.exchange,
      price,
      openPrice24h: open,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat((isWs ? t.h : t.highPrice) ?? ''),
      low24h: parseFloat((isWs ? t.l : t.lowPrice) ?? ''),
      volume24h: parseFloat((isWs ? t.v : t.volume) ?? ''),
      trades24h: parseInt(isWs ? (t.n ?? '0') : String(t.count ?? 0), 10),
      quoteVolume24h: parseFloat((isWs ? t.q : t.quoteVolume) ?? ''),
      range1m: 0,
      natr5m: 0,
      corrBtc: null,
      tradesSpike: null,
      volumeSpike: null,
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
    let set = this.depthSubs.get(symbol)
    if (!set) {
      set = new Set()
      this.depthSubs.set(symbol, set)
    }
    set.add(cb)

    const stream = `${symbol.toLowerCase()}@depth@100ms`
    if (!this.depthStreams.has(stream)) {
      this.depthStreams.add(stream)
      this.depthPool.addStream(stream)
    }
    if (!this.depthBooks.has(symbol)) this.initDepthBook(symbol)
  }

  unsubscribeDepth(symbol: string, cb?: DepthCallback) {
    const set = this.depthSubs.get(symbol)
    if (set && cb) set.delete(cb)
    if (!set || set.size === 0) {
      this.depthSubs.delete(symbol)
      const stream = `${symbol.toLowerCase()}@depth@100ms`
      if (this.depthStreams.delete(stream)) this.depthPool.removeStream(stream)
      this.depthBooks.delete(symbol)
      this.depthBookLoading.delete(symbol)
      this.lastDepthEmitAt.delete(symbol)
    }
  }

  /** Diff-depth assembly: seed the local book with a REST snapshot, then
   *  replay buffered diff events (Binance's standard snapshot+delta dance).
   *  A 100-level seed is enough — WS diffs grow the book from there. */
  private async initDepthBook(symbol: string) {
    if (this.depthBookLoading.has(symbol)) return
    this.depthBookLoading.add(symbol)
    // Create the book BEFORE the fetch: diff events arriving during the
    // snapshot window must BUFFER into it. Creating it after the fetch
    // drops those events, so the first post-snapshot event shows a gap
    // (U > lastUpdateId + 1) → instant resync → permanent reseed loop.
    const book = this.depthBooks.get(symbol) ?? new BinanceDepthBook()
    this.depthBooks.set(symbol, book)
    try {
      const snap = await this.fetchDepth(symbol, 100)
      if (snap.bids.length > 0 && typeof snap.lastUpdateId === 'number') {
        book.setSnapshot(snap.bids, snap.asks, snap.lastUpdateId)
      }
    } catch {
      // snapshot failed — the retry loop re-seeds
    } finally {
      this.depthBookLoading.delete(symbol)
      this.scheduleDepthBookRetry(symbol)
    }
  }

  /** Budget-gated snapshots can be skipped for a long time under heavy
   *  history churn; keep re-seeding until the book syncs (stops on its own
   *  once synced or unsubscribed). Backoff doubles per failure so a starved
   *  rate limiter isn't hammered by hundreds of retries every 15s. */
  private scheduleDepthBookRetry(symbol: string) {
    const book = this.depthBooks.get(symbol)
    if (!book || book.synced) {
      this.depthRetryDelay.delete(symbol)
      return
    }
    const delay = Math.min(120_000, (this.depthRetryDelay.get(symbol) ?? 7_500) * 2)
    this.depthRetryDelay.set(symbol, delay)
    setTimeout(() => {
      const cur = this.depthBooks.get(symbol)
      if (this.depthSubs.has(symbol) && cur && !cur.synced) this.initDepthBook(symbol)
    }, delay)
  }

  handleDepthMsg(msg: BinanceDepthDiffRaw): UnifiedDepth | null {
    const d = msg.data || msg
    const symbol = d.s || d.symbol || ''
    if (!symbol || d.U === undefined || d.u === undefined) return null
    const book = this.depthBooks.get(symbol)
    if (!book) return null

    const ev: DiffDepthEvent = { U: d.U, u: d.u, b: d.b ?? [], a: d.a ?? [] }
    const result = book.applyDiff(ev)
    if (result === 'resync') {
      // Backoff scheduler instead of an immediate reseed: a flapping book
      // must not burn the REST budget (candle history starves).
      this.scheduleDepthBookRetry(symbol)
      return null
    }
    if (result !== 'applied') return null

    // Emit full snapshots at most every 200ms per symbol — the book is
    // cumulative, so latest-wins loses nothing and bounds per-symbol cost.
    const now = Date.now()
    const last = this.lastDepthEmitAt.get(symbol) ?? 0
    if (now - last < 200) return null
    this.lastDepthEmitAt.set(symbol, now)
    return book.toDepth(symbol, this.exchange)
  }

  parseCandle(msg: BinanceCandleMsg): UnifiedCandle | null {
    const k = msg.k || msg.data?.k
    if (!k) return null
    return {
      symbol: k.s ?? '',
      exchange: this.exchange,
      timeframe: k.i ?? '',
      time: (k.t ?? 0) / 1000,
      open: parseFloat(k.o ?? ''),
      high: parseFloat(k.h ?? ''),
      low: parseFloat(k.l ?? ''),
      close: parseFloat(k.c ?? ''),
      volume: parseFloat(k.v ?? ''),
      isFinal: !!k.x,
    }
  }

  async fetchCandles(symbol: string, tf: string, limit: number, startTime?: number, endTime?: number, options?: import('./types.js').FetchCandlesOptions): Promise<UnifiedCandle[]> {
    const interval = TF_MAP[tf] || '1m'
    const safeLimit = Math.max(1, Math.min(limit, MAX_KLINES_LIMIT))
    const params = new URLSearchParams({ symbol, interval, limit: String(safeLimit) })
    if (startTime !== undefined) params.set('startTime', String(startTime))
    if (endTime !== undefined) params.set('endTime', String(endTime))
    const url = `https://api.binance.com/api/v3/klines?${params.toString()}`
    await this.rateLimiter.waitIfThrottled()
    try {
      const res = await fetchWithTimeout(url, 10000, options?.dispatcher ?? this.fetchDispatcher)
      this.rateLimiter.updateFromHeaders(res.headers)
      // Throttling must NOT masquerade as end-of-history: an empty array read
      // "no older data" downstream and silently emptied chart pages. Throw a
      // typed error so the history layer retries/fails properly.
      if (res.status === 429) { this.rateLimiter.handle429(res.headers); throw new RateLimitError(`spot 429 (${symbol} ${tf})`) }
      if (res.status === 418) { this.rateLimiter.handle418(res.headers); throw new RateLimitError(`spot 418 IP ban (${symbol} ${tf})`) }
      if (!res.ok) { this.rateLimiter.recordError(); throw new ExchangeRequestError(`spot ${res.status} (${symbol} ${tf})`) }
      const data = await res.json()
      if (!Array.isArray(data)) { this.rateLimiter.recordError(); throw new ExchangeRequestError(`spot invalid body (${symbol} ${tf})`) }
      this.rateLimiter.recordSuccess()
      return data.map((k: unknown[]) => ({
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
    } catch (e) {
      this.rateLimiter.recordError()
      throw e
    }
  }

  async fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth> {
    // Snapshots yield to candle history (charts): skip when throttled or
    // when the exchange is nearly at its limit (95%) — but otherwise proceed,
    // so depth seeding can't be starved by history churn.
    if (this.rateLimiter.isThrottled() || this.rateLimiter.isOverRatio(0.95)) {
      return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() }
    }
    const empty = { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() } as UnifiedDepth
    return withDepthSnapshotSlot(async () => {
      await this.rateLimiter.waitIfThrottled()
      if (this.rateLimiter.isOverRatio(0.95)) return empty
      const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`
      try {
        const res = await fetchWithTimeout(url, 10000, this.fetchDispatcher)
        this.rateLimiter.updateFromHeaders(res.headers)
        if (res.status === 429) { this.rateLimiter.handle429(res.headers); return empty }
        if (res.status === 418) { this.rateLimiter.handle418(res.headers); return empty }
        if (!res.ok) { this.rateLimiter.recordError(); return empty }
        const data = await res.json()
        if (!data.bids || !data.asks) { this.rateLimiter.recordError(); return empty }
        this.rateLimiter.recordSuccess()
        return {
          symbol,
          exchange: this.exchange,
          bids: data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
          asks: data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
          timestamp: Date.now(),
          lastUpdateId: typeof data.lastUpdateId === 'number' ? data.lastUpdateId : undefined,
        }
      } catch (e) {
        this.rateLimiter.recordError()
        throw e
      }
    })
  }
}
