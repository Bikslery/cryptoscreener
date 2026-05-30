import WebSocket from 'ws'
import type { ExchangeAdapter, TickerCallback, CandleCallback, DepthCallback } from './types.js'
import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { precisionFromTickSize, fallbackPrecision } from '../../utils/precision.js'

export class OkxSpotAdapter implements ExchangeAdapter {
  name = 'OKX Spot'
  type: 'spot' | 'futures' = 'spot'
  exchange: Exchange = 'okx-spot'

  private ws: WebSocket | null = null
  private tickerCbs: TickerCallback[] = []
  private candleCbs: CandleCallback[] = []
  private depthCbs: DepthCallback[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private precisionMap = new Map<string, number>()

  onTicker(cb: TickerCallback) { this.tickerCbs.push(cb) }
  onCandle(cb: CandleCallback) { this.candleCbs.push(cb) }
  onDepth(cb: DepthCallback) { this.depthCbs.push(cb) }

  connect() {
    this.fetchInstruments()
    const url = 'wss://ws.okx.com:8443/ws/v5/public'
    this.ws = new WebSocket(url)
    this.ws.on('open', () => {
      this.pingTimer = setInterval(() => {
        this.ws?.send('ping')
      }, 20000)
    })
    this.ws.on('message', (raw) => {
      const str = raw.toString()
      if (str === 'pong') return
      try {
        const msg = JSON.parse(str)
        if (msg.arg?.channel?.startsWith('tickers')) {
          const ticker = this.parseTicker(msg.data?.[0])
          if (ticker) for (const cb of this.tickerCbs) cb(ticker)
        } else if (msg.arg?.channel?.startsWith('candle')) {
          const candle = this.parseCandle(msg.data?.[0], msg.arg.instId)
          if (candle) for (const cb of this.candleCbs) cb(candle)
        } else if (msg.arg?.channel?.startsWith('books')) {
          const depth = this.parseDepth(msg.data?.[0], msg.arg.instId)
          if (depth) for (const cb of this.depthCbs) cb(depth)
        }
      } catch {}
    })
    this.ws.on('close', () => this.scheduleReconnect())
    this.ws.on('error', () => this.scheduleReconnect())
  }

  private async fetchInstruments() {
    try {
      const res = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT')
      const json = await res.json()
      if (json.code !== '0' || !json.data) return
      for (const inst of json.data) {
        if (!inst.instId?.endsWith('-USDT')) continue
        const symbol = inst.instId.replace('-USDT', 'USDT')
        if (inst.tickSz) {
          this.precisionMap.set(symbol, precisionFromTickSize(inst.tickSz))
        }
      }
      console.log(`[${this.name}] Loaded precision for ${this.precisionMap.size} instruments`)
    } catch (e) {
      console.error(`[${this.name}] Failed to fetch instruments:`, e)
    }
  }

  private parseTicker(d: any): UnifiedTicker | null {
    if (!d) return null
    const price = parseFloat(d.last)
    const open = parseFloat(d.open24h) || price
    const symbol = d.instId?.replace('-USDT', 'USDT') || d.instId || ''
    const pricePrecision = this.precisionMap.get(symbol) ?? fallbackPrecision(price)
    return {
      symbol,
      exchange: this.exchange,
      price,
      change24h: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(d.high24h),
      low24h: parseFloat(d.low24h),
      volume24h: parseFloat(d.vol24h),
      trades24h: 0,
      quoteVolume24h: parseFloat(d.volCcy24h),
      range1m: 0,
      natr5m: 0,
      pricePrecision,
      timestamp: Date.now(),
    }
  }

  private parseCandle(d: any, instId: string): UnifiedCandle | null {
    if (!d) return null
    return {
      symbol: instId?.replace('-USDT', 'USDT') || instId || '',
      exchange: this.exchange,
      timeframe: '', // extracted from channel
      time: parseInt(d[0]) / 1000,
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    }
  }

  private parseDepth(d: any, instId: string): UnifiedDepth | null {
    if (!d?.bids || !d?.asks) return null
    return {
      symbol: instId?.replace('-USDT', 'USDT') || instId || '',
      exchange: this.exchange,
      bids: d.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: d.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: Date.now(),
    }
  }

  subscribeCandle(_symbol: string, _tf: string, _cb: CandleCallback) {
    // TODO: implement OKX kline subscription
  }

  unsubscribeCandle(_symbol: string, _tf: string) {
    // TODO
  }

  subscribeDepth(_symbol: string, _cb: DepthCallback) {
    // TODO: implement OKX orderbook subscription
  }

  unsubscribeDepth(_symbol: string) {
    // TODO
  }

  disconnect() {
    this.ws?.close()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
  }

  async fetchCandles(symbol: string, tf: string, limit: number): Promise<UnifiedCandle[]> {
    const instId = symbol.replace(/USDT$/, '-USDT')
    const barMap: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' }
    const bar = barMap[tf] || '1m'
    const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.code !== '0' || !json.data) return []
    return json.data.map((k: any[]) => ({
      symbol,
      exchange: this.exchange,
      timeframe: tf,
      time: parseInt(k[0]) / 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
  }

  async fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth> {
    const instId = symbol.replace(/USDT$/, '-USDT')
    const url = `https://www.okx.com/api/v5/market/books?instId=${instId}&sz=${limit}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.code !== '0' || !json.data?.[0]) {
      return { symbol, exchange: this.exchange, bids: [], asks: [], timestamp: Date.now() }
    }
    const d = json.data[0]
    return {
      symbol,
      exchange: this.exchange,
      bids: d.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
      asks: d.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
      timestamp: Date.now(),
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 5000)
  }
}
