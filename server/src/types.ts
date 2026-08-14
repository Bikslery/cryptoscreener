export type Exchange = 'binance-spot' | 'binance-futures' | 'bybit-futures' | 'okx-spot' | 'okx-futures'

export interface UnifiedTicker {
  symbol: string
  exchange: Exchange
  price: number
  openPrice24h: number
  change24h: number
  high24h: number
  low24h: number
  volume24h: number
  trades24h: number
  quoteVolume24h: number
  range1m: number
  natr5m: number
  corrBtc: number | null
  tradesSpike: number | null
  volumeSpike: number | null
  pricePrecision: number
  timestamp: number
}

export interface UnifiedCandle {
  symbol: string
  exchange: Exchange
  timeframe: string
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  isFinal?: boolean
}

export interface UnifiedDepth {
  symbol: string
  exchange: Exchange
  bids: [number, number][]
  asks: [number, number][]
  timestamp: number
}

export type AlertType = 'price' | 'impulse' | 'listing'

export interface PriceAlertCondition {
  price: number
  direction: 'above' | 'below'
}

export interface ImpulseExchangeCondition {
  exchange: Exchange
  minVolume24h: number
}

export interface ImpulseAlertCondition {
  percent: number
  timeframe: '1m' | '5m'
  direction: 'up' | 'down' | 'both'
  volumeSpike: number
  exchanges: ImpulseExchangeCondition[]
  /** Opt-in Telegram delivery (default false — browser only). */
  telegram?: boolean
  lastFiredCandleTime?: number
  /** Scalpboard-style mute: no refires for this alert until this ms epoch. */
  mutedUntil?: number
}

export interface ListingAlertCondition {
  exchange: Exchange
}

export interface Alert {
  id: string
  userId: string
  type: AlertType
  symbol: string
  exchange: Exchange | null
  condition: PriceAlertCondition | ImpulseAlertCondition | ListingAlertCondition
  active: boolean
  muted: boolean
  triggeredAt: number | null
  createdAt: number
}

export type DrawingType = 'level' | 'measure'

export interface LevelDrawing {
  price: number
  color: string
  style: 'solid' | 'dashed'
}

export interface MeasureDrawing {
  fromPrice: number
  toPrice: number
  fromTime: number
  toTime: number
}

export interface Drawing {
  id: string
  userId: string
  symbol: string
  timeframe: string
  type: DrawingType
  data: LevelDrawing | MeasureDrawing
}

export interface Watchlist {
  id: string
  userId: string
  name: string
  coins: string[]
}

export interface UserSettings {
  theme: 'dark' | 'light'
  layout: {
    coinListWidth: number
    alertsWidth: number
  }
  defaultTimeframe: string
  chartBlocks: string[]
  /** opaque passthrough — full cascade/density engine config from the cabinet */
  cascades?: Record<string, unknown>
  /** opaque passthrough — coin list / chart header indicator columns */
  indicators?: Record<string, unknown>
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w'

export interface WsMessage {
  type: 'subscribe' | 'unsubscribe' | 'ticker' | 'candle' | 'depth' | 'alert' | 'listing' | 'initial-candles' | 'auth'
  channel?: string
  data?: unknown
  full?: unknown // full array for ticker delta broadcasts
  delta?: boolean // ticker message carries only changed entries (merge in place)
  snapshot?: boolean // ticker message carries the full array (replace state)
  token?: string // JWT token for WS auth
  ts?: number // server timestamp (ms) — client uses it for p50/p95 latency
}

export interface ChartBlock {
  id: string
  symbol: string
  timeframe: Timeframe
  focused: boolean
  selected: boolean
}

export interface DensityCell {
  symbol: string
  exchange: Exchange
  side: 'bid' | 'ask'
  price: number
  volume: number
  distancePct: number
  marketCap: 'large' | 'medium' | 'small'
  pricePrecision: number
}
