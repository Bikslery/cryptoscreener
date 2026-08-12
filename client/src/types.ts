export type Exchange = 'binance-spot' | 'binance-futures' | 'bybit-futures' | 'okx-spot' | 'okx-futures'

export interface UnifiedTicker {
  symbol: string
  exchange: Exchange
  price: number
  change24h: number
  high24h: number
  low24h: number
  volume24h: number
  trades24h: number
  quoteVolume24h: number
  range1m: number
  natr5m: number
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
  source?: 'kline' | 'trade' | 'mid'
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

export interface ImpulseAlertCondition {
  percent: number
  within: string
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
  /** Price at trigger time (present on fired/WS alert payloads). */
  price?: number
  active: boolean
  muted: boolean
  triggeredAt: number | null
  createdAt: number
}

export type DrawingType = 'level' | 'measure' | 'h-ray' | 't-ray' | 'segment' | 'rect' | 'fib' | 'circle'

export type DrawingTool = 'h-ray' | 't-ray' | 'segment' | 'rect' | 'fib' | 'circle'

export const TWO_POINT_TOOLS: readonly DrawingTool[] = ['t-ray', 'segment', 'rect', 'fib', 'circle']

export function isTwoPointTool(tool: DrawingTool): boolean {
  return TWO_POINT_TOOLS.includes(tool)
}

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

export interface HRayDrawing {
  price: number
  time: number
  logical?: number
}

export interface TRayDrawing {
  fromPrice: number
  fromTime: number
  fromLogical?: number
  toPrice: number
  toTime: number
  toLogical?: number
}

export interface SegmentDrawing {
  fromPrice: number
  fromTime: number
  fromLogical?: number
  toPrice: number
  toTime: number
  toLogical?: number
}

export interface RectDrawing {
  fromPrice: number
  fromTime: number
  fromLogical?: number
  toPrice: number
  toTime: number
  toLogical?: number
}

export interface FibDrawing {
  fromPrice: number
  fromTime: number
  fromLogical?: number
  toPrice: number
  toTime: number
  toLogical?: number
}

export interface CircleDrawing {
  fromPrice: number
  fromTime: number
  fromLogical?: number
  toPrice: number
  toTime: number
  toLogical?: number
}

export type TwoPointDrawing = TRayDrawing | SegmentDrawing | RectDrawing | FibDrawing | CircleDrawing

export interface Drawing {
  id: string
  userId: string
  symbol: string
  type: DrawingType
  data: LevelDrawing | MeasureDrawing | HRayDrawing | TRayDrawing | SegmentDrawing | RectDrawing | FibDrawing | CircleDrawing
}

export interface Watchlist {
  id: string
  userId: string
  name: string
  coins: string[]
}

export interface UserSettings {
  theme?: 'dark' | 'light'
  layout?: {
    coinListWidth: number
    alertsWidth: number
    mapHeight: number
  }
  defaultTimeframe?: string
  chartBlocks?: string[]
  drawingHotkeys?: Record<DrawingTool, string>
  // Initial visible bars when opening the expanded chart (50–1000).
  chartVisibleBars?: number
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w'

export interface WsMessage {
  type: 'subscribe' | 'unsubscribe' | 'ticker' | 'candle' | 'depth' | 'alert' | 'listing' | 'initial-candles' | 'open'
  channel?: string
  data?: unknown
  delta?: boolean // ticker message carries only changed entries (merge in place)
  snapshot?: boolean // ticker message carries the full array (replace state)
  ts?: number // server timestamp (ms) — used for p50/p95 latency
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
