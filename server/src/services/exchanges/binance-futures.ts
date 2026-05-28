import WebSocket from 'ws'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'

const TF_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1d', '1w': '1w',
}

export class BinanceFuturesAdapter implements ExchangeAdapter {
  name = 'Binance Futures'
  type: 'spot' | 'futures' = 'futures'
  exchange: Exchange = 'binance-futures'

  private candleWs: WebSocket | null = null
  private depthWs: WebSocket | null = null
  private candleSubs = new Map<string, CandleCallback>()
  private depthSubs = new Map<string, DepthCallback>()
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reconnectCandleTimer: ReturnType<typeof setTimeout> | null = null
  private precisionMap = new Map<string, number>()

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }

  connect() {
    this.fetchExchangeInfo()
    this.pollTickers()
    this.pollTimer = setInterval(() => this.pollTickers(), 2000)
    console.log(`[${this.name}] Connected (REST polling for tickers)`)
  }

  private async fetchExchangeInfo() {
    try {
      const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')
      const data = await res.json()
      for (const s of data.symbols || []) {
        if (!s.symbol.endsWith('USDT')) continue
        for (const f of s.filters || []) {
          if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
            this.precisionMap.set(s.symbol, precisionFromTickSize(f.tickSize))
            break
          }
        }
      }
      console.log(`[${this.name}] Loaded precision for ${this.precisionMap.size} symbols`)
    } catch (e) {
      console.error(`[${this.name}] Failed to fetch exchangeInfo:`, e)
    }
  }

  private async pollTickers() {
    try {
      const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')
      const arr = await res.json()
      for (const t of arr) {
        if (!t.symbol.endsWith('USDT')) continue
        const ticker = this.parseTicker(t)
        for (const cb of this.tickerCbs) cb(ticker)
      }
    } catch {}
  }

  private parseTicker(t: any): UnifiedTicker {
    const price = parseFloat(t.lastPrice)
    const open = parseFloat(t.openPrice)
    const pricePrecision = this.precisionMap.get(t.symbol) ?? fallbackPrecision(price)
    return {
      symbol: t.symbol,
      exchange: this.exchange,
      price,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(t.highPrice),
      low24h: parseFloat(t.lowPrice),
      volume24h: parseFloat(t.volume),
      trades24h: parseInt(t.count),
      quoteVolume24h: parseFloat(t.quoteVolume || t.quoteVolume),
      range1m: 0,
      natr5m: 0,
      pricePrecision,
      timestamp: Date.now(),
    }
  }

  disconnect() {
    this.candleWs?.close()
    this.depthWs?.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
  }

  subscribeCandle(symbol: string, tf: string, cb: CandleCallback) {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[tf] || '1m'}`
    this.candleSubs.set(stream, cb)
    this.reconnectCandles()
  }

  unsubscribeCandle(symbol: string, tf: string) {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[tf] || '1m'}`
    this.candleSubs.delete(stream)
    this.reconnectCandles()
  }

  subscribeDepth(symbol: string, cb: DepthCallback) {
    const stream = `${symbol.toLowerCase()}@depth20@100ms`
    this.depthSubs.set(stream, cb)
    this.reconnectDepth()
  }

  unsubscribeDepth(symbol: string) {
    const stream = `${symbol.toLowerCase()}@depth20@100ms`
    this.depthSubs.delete(stream)
    this.reconnectDepth()
  }

  private reconnectCandles() {
    if (this.reconnectCandleTimer) {
      clearTimeout(this.reconnectCandleTimer)
    }
    this.reconnectCandleTimer = setTimeout(() => {
      this.reconnectCandleTimer = null
      this.doReconnectCandles()
    }, 300)
  }

  private doReconnectCandles() {
    if (this.candleSubs.size === 0) {
      if (this.candleWs) {
        try { this.candleWs.close() } catch {}
        this.candleWs = null
      }
      return
    }
    if (this.candleWs && this.candleWs.readyState !== WebSocket.CONNECTING) {
      try { this.candleWs.close() } catch {}
    }
    const streams = Array.from(this.candleSubs.keys()).join('/')
    const url = `wss://fstream.binance.com/stream?streams=${streams}`
    console.log(`[Binance Futures] Candle WS connecting: ${url}`)
    this.candleWs = new WebSocket(url)

    this.candleWs.on('open', () => {
      console.log(`[Binance Futures] Candle WS connected (${this.candleSubs.size} streams)`)
    })

    this.candleWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        const candle = this.parseCandle(msg)
        if (candle) {
          for (const cb of this.candleCbs) cb(candle)
          const subCb = this.candleSubs.get(msg.stream)
          if (subCb) subCb(candle)
        }
      } catch (e) {
        console.error('[Binance Futures] Candle parse error:', e)
      }
    })

    this.candleWs.on('error', (err) => {
      console.error(`[Binance Futures] Candle WS error:`, err.message || err)
    })

    this.candleWs.on('close', () => {
      console.log(`[Binance Futures] Candle WS closed, reconnecting in 3s...`)
      setTimeout(() => this.doReconnectCandles(), 3000)
    })
  }

  private reconnectDepth() {
    if (this.depthSubs.size === 0) {
      if (this.depthWs) {
        try { this.depthWs.close() } catch {}
        this.depthWs = null
      }
      return
    }
    if (this.depthWs && this.depthWs.readyState !== WebSocket.CONNECTING) {
      try { this.depthWs.close() } catch {}
    }
    const streams = Array.from(this.depthSubs.keys()).join('/')
    const url = `wss://fstream.binance.com/stream?streams=${streams}`
    this.depthWs = new WebSocket(url)
    this.depthWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        const depth = this.parseDepth(msg)
        if (depth) {
          for (const cb of this.depthCbs) cb(depth)
        }
      } catch {}
    })
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

  async fetchCandles(symbol: string, tf: string, limit: number, startTime?: number, endTime?: number): Promise<UnifiedCandle[]> {
    const interval = TF_MAP[tf] || '1m'
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) })
    if (startTime !== undefined) params.set('startTime', String(startTime))
    if (endTime !== undefined) params.set('endTime', String(endTime))
    const url = `https://fapi.binance.com/fapi/v1/klines?${params.toString()}`
    const res = await fetch(url)
    const data = await res.json()
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
  }

  async fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth> {
    const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`
    const res = await fetch(url)
    const data = await res.json()
    return {
      symbol,
      exchange: this.exchange,
      bids: data.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: data.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: Date.now(),
    }
  }
}
