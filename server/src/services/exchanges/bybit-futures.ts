import WebSocket from 'ws'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'
import { fetchWithTimeout } from '../../utils/fetch.js'

const TF_MAP: Record<string, string> = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W',
}

export class BybitFuturesAdapter implements ExchangeAdapter {
  name = 'Bybit Futures'
  type: 'spot' | 'futures' = 'futures'
  exchange: Exchange = 'bybit-futures'

  private ws: WebSocket | null = null
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private bookTickerCbs: Array<(symbol: string, midPrice: number) => void> = []
  private bookTickerSubs = new Set<string>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private subscribedSymbols = new Set<string>()
  private candleSubs = new Map<string, CandleCallback>()
  private precisionMap = new Map<string, number>()
  private intentionalClose = false

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }
  onBookTicker(cb: (symbol: string, midPrice: number) => void) { this.bookTickerCbs.push(cb) }

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
    this.fetchInstruments()
    const url = 'wss://stream.bybit.com/v5/public/linear'
    this.ws = new WebSocket(url)
    this.ws.on('open', () => {
      this.pingTimer = setInterval(() => {
        this.ws?.send(JSON.stringify({ op: 'ping' }))
      }, 20000)
      this.subscribeAll()
    })
    this.ws.on('message', (raw) => {
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
            if (depth) for (const cb of this.depthCbs) cb(depth)
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
      const res = await fetchWithTimeout('https://api.bybit.com/v5/market/instruments-info?category=linear')
      const json = await res.json()
      if (json.retCode !== 0 || !json.result?.list) return
      for (const inst of json.result.list) {
        if (!inst.symbol?.endsWith('USDT')) continue
        const tickSize = inst.priceFilter?.tickSize
        if (tickSize) {
          this.precisionMap.set(inst.symbol, precisionFromTickSize(tickSize))
        }
      }
      console.log(`[${this.name}] Loaded precision for ${this.precisionMap.size} instruments`)
      this.subscribeAll()
    } catch (e) {
      console.error(`[${this.name}] Failed to fetch instruments:`, e)
    }
  }

  private parseTicker(d: any): UnifiedTicker | null {
    const price = parseFloat(d.lastPrice)
    // Bybit ticker 'delta' messages can omit lastPrice (only changed fields) —
    // skip them instead of emitting NaN (which JSON-serializes to null and
    // made the price flicker to null in the UI).
    if (!isFinite(price) || price <= 0) return null
    const open = parseFloat(d.prevPrice24h) || price
    const pricePrecision = this.precisionMap.get(d.symbol) ?? fallbackPrecision(price)
    return {
      symbol: d.symbol,
      exchange: this.exchange,
      price,
      openPrice24h: open,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(d.highPrice24h),
      low24h: parseFloat(d.lowPrice24h),
      volume24h: parseFloat(d.volume24h),
      trades24h: 0,
      quoteVolume24h: parseFloat(d.turnover24h),
      range1m: 0,
      natr5m: 0,
      corrBtc: null,
      tradesSpike: null,
      volumeSpike: null,
      pricePrecision,
      timestamp: Date.now(),
    }
  }

  private parseCandle(d: any, topic: string): UnifiedCandle | null {
    if (!d) return null
    const c = Array.isArray(d) ? d[0] : d
    const symbol = c.symbol || topic.split('.').pop() || ''
    const interval = topic.split('.')[1] || ''
    const timeframe = Object.entries(TF_MAP).find(([, v]) => v === interval)?.[0] || '5m'
    if (!symbol || !isFinite(c.start)) return null
    return {
      symbol,
      exchange: this.exchange,
      timeframe,
      time: c.start / 1000,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
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
    for (let i = 0; i < args.length; i += 10) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 10) }))
    }
    if (args.length > 0) {
      console.log(`[${this.name}] Subscribed ${args.length} topics (tickers + klines)`)
    }
  }

  private parseDepth(d: any, topic: string): UnifiedDepth | null {
    if (!d.bids || !d.asks) return null
    const symbol = topic.split('.').pop() || ''
    return {
      symbol,
      exchange: this.exchange,
      bids: d.bids.map((b: any[]) => [parseFloat(String(b[0])), parseFloat(String(b[1]))]),
      asks: d.asks.map((a: any[]) => [parseFloat(String(a[0])), parseFloat(String(a[1]))]),
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

  subscribeDepth(_symbol: string, _cb: DepthCallback) {
    // TODO: implement Bybit orderbook subscription
  }

  unsubscribeDepth(_symbol: string) {
    // TODO
  }

  disconnect() {
    this.intentionalClose = true
    this.ws?.close()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
  }

  async fetchCandles(symbol: string, tf: string, limit: number): Promise<UnifiedCandle[]> {
    const category = 'linear'
    const bybitTfMap: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' }
    const interval = bybitTfMap[tf]
    if (!interval) return []
    const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`
    const res = await fetchWithTimeout(url)
    const json = await res.json()
    if (json.retCode !== 0 || !json.result?.list) return []
    return json.result.list.map((k: any[]) => ({
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
  }

  async fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth> {
    const url = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${limit}`
    const res = await fetchWithTimeout(url)
    const json = await res.json()
    if (json.retCode !== 0 || !json.result) {
      return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() }
    }
    return {
      symbol,
      exchange: this.exchange,
      bids: json.result.bids.map((b: any[]) => [parseFloat(String(b[0])), parseFloat(String(b[1]))]),
      asks: json.result.asks.map((a: any[]) => [parseFloat(String(a[0])), parseFloat(String(a[1]))]),
      timestamp: Date.now(),
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose) return
    if (this.reconnectTimer) return
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 5000)
  }
}
