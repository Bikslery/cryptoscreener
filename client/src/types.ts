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

export type DrawingTool = 'h-ray' | 't-ray' | 'segment' | 'rect' | 'fib' | 'circle' | 'alert'

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
  /** Dashed (alert-level) rays render amber with a dotted pattern. */
  style?: 'solid' | 'dashed'
  /** Linked price alert id — deleting the line deletes the alert and vice versa. */
  alertId?: string
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

/**
 * Full cascade (peaks/chains) configuration. Lives in the user cabinet
 * (server-persisted); the chart engine consumes it via
 * DEFAULT_CASCADES_CONFIG fallbacks.
 */
export interface CascadesConfig {
  /** render cascades at all */
  showCascades: boolean
  /** min members for a chain to become a cascade */
  minPeaks: number
  /** max directional step % between chained members */
  maxDistance: number
  /** ±bars used to compare an extremum against its neighbours (1 = scalpboard parity) */
  prominenceWindow: number
  /** an extremum must stand out at least this % from its window neighbours to be a peak */
  minProminencePct: number
  /** extremum candle volume must be >= this % of the window's max volume */
  minVolumePct: number
  /** only consider the last N candles for peaks (0 = whole history) */
  lookback: number
  /** max cascades drawn per side (0 = unlimited) */
  maxCascades: number
  /** max chain members per cascade (0 = unlimited) */
  maxChainLen: number
  /** min "touches" (candles approaching within touchDistancePct) for a cascade to be drawn (0 = no filter) */
  minTouches: number
  /** max % distance for a candle's extreme to count as a touch of a cascade level */
  touchDistancePct: number
  /** draw the price/volume labels next to cascade lines */
  showLabels: boolean
  /** cascade line width in px (1–3) */
  lineWidth: number
  /** cascade line opacity in % (10–100) */
  opacity: number
}

export interface UserSettings {
  theme?: 'dark' | 'light'
  layout?: {
    coinListWidth: number
    alertsWidth: number
  }
  defaultTimeframe?: string
  chartBlocks?: string[]
  drawingHotkeys?: Partial<Record<DrawingTool, string>>
  // Initial visible bars when opening the expanded chart (50–1000).
  chartVisibleBars?: number
  // Alert notifications: play a sound on fire (default true) and its volume (0–1).
  notifySound?: boolean
  notifyVolume?: number
  // Cascade engine configuration (all parameters, cabinet UI).
  cascades?: Partial<CascadesConfig>
}

export type Timeframe = '1s' | '5s' | '15s' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w'

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
