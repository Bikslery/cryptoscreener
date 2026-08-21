import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth, UnifiedTrade } from '../../types.js'
import type { BinanceRateLimiter } from './rate-limiter.js'
import type { Dispatcher } from 'undici'

export interface FetchCandlesOptions {
  dispatcher?: Dispatcher
}

export interface ExchangeAdapter {
  name: string
  type: 'spot' | 'futures'
  exchange: Exchange
  connect(): void
  disconnect(): void
  onTicker(cb: (t: UnifiedTicker) => void): void
  onCandle(cb: (c: UnifiedCandle) => void): void
  onDepth(cb: (d: UnifiedDepth) => void): void
  onTrade?(cb: TradeCallback): void
  /** Best bid/ask midpoint feed (bookTicker). Optional — only some adapters expose it. */
  onBookTicker?(cb: (symbol: string, midPrice: number) => void): void
  subscribeBookTicker?(symbol: string): void
  unsubscribeBookTicker?(symbol: string): void
  subscribeTrade?(symbol: string): void
  unsubscribeTrade?(symbol: string): void
  subscribeCandle(symbol: string, tf: string, cb: CandleCallback): void
  unsubscribeCandle(symbol: string, tf: string): void
  subscribeDepth(symbol: string, cb: DepthCallback): void
  unsubscribeDepth(symbol: string, cb?: DepthCallback): void
  fetchCandles(symbol: string, tf: string, limit: number, startTime?: number, endTime?: number, options?: FetchCandlesOptions): Promise<UnifiedCandle[]>
  fetchDepth(symbol: string, limit: number): Promise<UnifiedDepth>
  getRateLimiter?(): BinanceRateLimiter | null
}

export type TickerCallback = (t: UnifiedTicker) => void
export type CandleCallback = (c: UnifiedCandle) => void
export type DepthCallback = (d: UnifiedDepth) => void
export type TradeCallback = (t: UnifiedTrade) => void
