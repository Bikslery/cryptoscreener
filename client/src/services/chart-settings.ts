import { create } from 'zustand'
import type { Timeframe } from '../types'

// `hollow` remains in the type only so older persisted settings can be
// migrated safely. It is no longer offered by the UI or rendered with a
// transparent candle body.
export type CandlesType = 'default' | 'hollow' | 'bars' | 'line'
export type PriceScaleMode = 'default' | 'log'
export type WatermarkPlace =
  | 'center-center'
  | 'center-top'
  | 'center-bottom'
  | 'left-center'
  | 'right-center'

export interface IndicatorLineSetting {
  period: number
  color: string
}

export interface IndicatorSetting {
  type: 'oi' | 'natr' | 'rsi' | 'ema' | 'macd'
  period?: number
  fast?: number
  slow?: number
  signal?: number
  lines?: IndicatorLineSetting[]
  source?: string
}

/**
 * Chart settings — scalpboard.io parity ("kd" defaults from its settings
 * panel) persisted to localStorage. The "view" panel binds to this store;
 * chart components subscribe to the slices they render.
 */
export interface ChartSettings {
  interval: Timeframe
  volumesHeight: number
  rightOffset: number
  barSpace: number
  candlesType: CandlesType
  watermark: number
  watermarkSize: number
  watermarkPlace: WatermarkPlace
  watermarkPattern: string
  showDrawings: boolean
  showTriggeredAlerts: boolean
  showCountdown: boolean
  showDensities: boolean
  priceScaleMode: PriceScaleMode
  vertGrid: boolean
  horzGrid: boolean
  indicators: IndicatorSetting[]
  paneHeights: Record<string, number>
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  interval: '5m',
  volumesHeight: 15,
  rightOffset: 25,
  barSpace: 2,
  candlesType: 'default',
  watermark: 0.2,
  watermarkSize: 48,
  watermarkPlace: 'center-center',
  watermarkPattern: '{ticker}',
  showDrawings: true,
  showTriggeredAlerts: true,
  showCountdown: false,
  showDensities: true,
  priceScaleMode: 'default',
  vertGrid: true,
  horzGrid: true,
  indicators: [],
  paneHeights: {},
}

const STORAGE_KEY = 'sc.chart.settings.v1'

function loadSettings(): ChartSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CHART_SETTINGS
    const parsed = JSON.parse(raw) as Partial<ChartSettings>
    if (parsed.candlesType === 'hollow') parsed.candlesType = 'default'
    return { ...DEFAULT_CHART_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_CHART_SETTINGS
  }
}

interface ChartSettingsStore extends ChartSettings {
  setSetting: <K extends keyof ChartSettings>(key: K, value: ChartSettings[K]) => void
}

function persistAll(s: ChartSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable — settings stay in-memory */
  }
}

export const useChartSettings = create<ChartSettingsStore>((set) => ({
  ...loadSettings(),
  setSetting: (key, value) =>
    set((state) => {
      const next = { ...state, [key]: value }
      persistAll(next)
      return next
    }),
}))

export function resetChartSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* noop */ }
  useChartSettings.setState({ ...DEFAULT_CHART_SETTINGS })
}
