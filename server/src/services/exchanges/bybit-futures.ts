import WebSocket from 'ws'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'
import { fetchWithTimeout } from '../../utils/fetch.js'

export class BybitFuturesAdapter implements ExchangeAdapter {
  name = 'Bybit Futures'
  type: 'spot' | 'futures' = 'futures'
  exchange: Exchange = 'bybit-futures'

  private ws: WebSocket | null = null
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private subscribedSymbols = new Set<string>()
  private precisionMap = new Map<string, number>()
  private intentionalClose = false

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }

  connect() {
    this.fetchInstruments()
    const url = 'wss://stream.bybit.com/v5/public/linear'
    this.ws = new WebSocket(url)
    this.ws.on('open', () => {
      this.pingTimer = setInterval(() => {
        this.ws?.send(JSON.stringify({ op: 'ping' }))
      }, 20000)
    })
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.topic) {
          if (msg.topic.startsWith('tickers.')) {
            const ticker = this.parseTicker(msg.data)
            for (const cb of this.tickerCbs) cb(ticker)
          } else if (msg.topic.startsWith('kline.')) {
            const candle = this.parseCandle(msg.data)
            if (candle) for (const cb of this.candleCbs) cb(candle)
          } else if (msg.topic.startsWith('orderbook.')) {
            const depth = this.parseDepth(msg.data, msg.topic)
            if (depth) for (const cb of this.depthCbs) cb(depth)
          }
        }
      } catch {}
    })
    this.ws.on('close', () => this.scheduleReconnect())
    this.ws.on('error', () => this.scheduleReconnect())
  }

  private async fetchInstruments() {
    try {
      const res = await fetchWithTimeout('https://api.bybit.com/v5/market/instruments?category=linear')
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
    } catch (e) {
      console.error(`[${this.name}] Failed to fetch instruments:`, e)
    }
  }

  private parseTicker(d: any): UnifiedTicker {
    const price = parseFloat(d.lastPrice)
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
      pricePrecision,
      timestamp: Date.now(),
    }
  }

  private parseCandle(d: any): UnifiedCandle | null {
    if (!d || !d.start) return null
    const c = Array.isArray(d) ? d[0] : d
    return {
      symbol: c.symbol || '',
      exchange: this.exchange,
      timeframe: '', // extracted from topic
      time: c.start / 1000,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
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

  subscribeCandle(_symbol: string, _tf: string, _cb: CandleCallback) {
    // TODO: implement Bybit kline subscription
  }

  unsubscribeCandle(_symbol: string, _tf: string) {
    // TODO
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
    const interval = bybitTfMap[tf] || tf
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
