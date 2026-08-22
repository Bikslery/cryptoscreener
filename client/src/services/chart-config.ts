import { CrosshairMode, PriceScaleMode } from 'lightweight-charts'
import type { DeepPartial, ChartOptions, CandlestickSeriesOptions, BarSeriesOptions, LineSeriesOptions, HistogramSeriesOptions, HorzAlign, VertAlign, IChartApi, ITextWatermarkPluginApi, AutoscaleInfoProvider, AutoscaleInfo } from 'lightweight-charts'
import { createTextWatermark } from 'lightweight-charts'
import type { ChartSettings } from './chart-settings'
import { detectLocalOutliers, type OutlierCheckBar } from './candle-utils'

/**
 * scalpboard.io chart parity helpers.
 *
 * The scalpboard frontend resolves every color from CSS custom properties
 * via its At() helper. This module is the same thing: all chart appearances
 * come from :root vars (see index.css "Scalpboard.io dark palette"), never
 * from hardcoded hexes, so a theme change re-skins every chart.
 */

const cssVarCache = new Map<string, string>()

/** cached CSS custom property lookup (scalpboard's At()) */
export function At(name: string, fallback: string): string {
  const hit = cssVarCache.get(name)
  if (hit !== undefined) return hit
  let value = fallback
  if (typeof document !== 'undefined') {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  }
  if (value) cssVarCache.set(name, value)
  return value
}

const WINDOW_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800, '1M': 2592e3,
}

/** seconds per timeframe (scalpboard's pe()) */
export function windowSeconds(tf: string): number {
  return WINDOW_SECONDS[tf] ?? 60
}

const hexToRgba = (hex: string, alpha: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`
}

export interface ChartScaleMargins { top: number; bottom: number }

/** base chart options — scalpboard's Dl() plus per-chart scale margins */
export function buildChartOptions(s: ChartSettings, scaleMargins: ChartScaleMargins): DeepPartial<ChartOptions> {
  return {
    timeScale: {
      secondsVisible: secondsVisibleFor(s.interval),
      minBarSpacing: 0.1,
      borderColor: At('--border', '#242424'),
      timeVisible: timeVisibleFor(s.interval),
      visible: true,
      barSpacing: s.barSpace,
      rightOffset: s.rightOffset,
      fixLeftEdge: false,
      fixRightEdge: false,
    },
    trackingMode: { exitMode: 0 },
    rightPriceScale: {
      mode: s.priceScaleMode === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      borderColor: At('--border', '#242424'),
      scaleMargins,
    },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, pinch: true, mouseWheel: true },
    layout: {
      panes: {
        separatorColor: At('--border', '#242424'),
        separatorHoverColor: At('--border', '#242424'),
      },
      attributionLogo: false,
      fontSize: 11,
      background: { color: 'transparent' },
      textColor: At('--foreground-50', '#cccccc80'),
    },
    grid: {
      vertLines: { color: At('--chart--grid', '#1f1f1f'), visible: s.vertGrid },
      horzLines: { color: At('--chart--grid', '#1f1f1f'), visible: s.horzGrid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: At('--chart--crosshair', '#4d4d4d'), labelBackgroundColor: At('--chart--crosshair', '#4d4d4d') },
      horzLine: { color: At('--chart--crosshair', '#4d4d4d'), labelBackgroundColor: At('--chart--crosshair', '#4d4d4d') },
    },
  }
}

type AnySeriesOptions = DeepPartial<CandlestickSeriesOptions> | DeepPartial<BarSeriesOptions> | DeepPartial<LineSeriesOptions>

/** main series options per candlesType — scalpboard's ki() */
export function candleSeriesOptions(s: ChartSettings): AnySeriesOptions {
  if (s.candlesType === 'bars') {
    return {
      lastValueVisible: true,
      priceLineColor: At('--chart--price', '#b3b3b3'),
      upColor: At('--chart--candle-up', '#4bd24b'),
      downColor: At('--chart--candle-down', '#d24b4b'),
    }
  }
  if (s.candlesType === 'line') {
    return {
      lastValueVisible: true,
      priceLineColor: At('--foreground', '#cccccc'),
      lineColor: At('--foreground', '#cccccc'),
      topColor: At('--foreground-25', '#cccccc40'),
      bottomColor: At('--foreground-10', '#cccccc1a'),
    } as DeepPartial<LineSeriesOptions>
  }
  return {
    lastValueVisible: true,
    priceLineColor: At('--chart--price', '#b3b3b3'),
    // Candle bodies must stay opaque. The former hollow mode used a
    // transparent upColor, which made candles disappear into overlays and
    // persisted across sessions through chart settings.
    upColor: At('--chart--candle-up', '#4bd24b'),
    borderUpColor: At('--chart--candle-border-up', '#4bd24b'),
    wickUpColor: At('--chart--candle-border-up', '#4bd24b'),
    downColor: At('--chart--candle-down', '#d24b4b'),
    borderDownColor: At('--chart--candle-border-down', '#d24b4b'),
    wickDownColor: At('--chart--candle-border-down', '#d24b4b'),
  }
}

/** volume subchart options — scalpboard's Ol() */
export function volumeSeriesOptions(): DeepPartial<HistogramSeriesOptions> {
  return {
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: { type: 'volume' },
    color: At('--chart--volumes', '#4d4d4d'),
  }
}

/**
 * Autoscale guard: ONE locally-anomalous bar (a 10x bad print, a stitched
 * foreign-venue row) otherwise stretches the whole visible price scale so
 * every real candle collapses into a flat dotted line with empty space above
 * and below. The provider computes the scale from all bars EXCEPT the ones
 * detectLocalOutliers flags; the anomalous bars stay in the data (honest
 * history), they just stop dictating the zoom.
 */
export function clampedAutoscaleProvider(
  getCandles: () => OutlierCheckBar[] | null | undefined,
): AutoscaleInfoProvider {
  return (base) => {
    let res: AutoscaleInfo | null
    try {
      res = base()
    } catch {
      // Library failed to compute a range (empty/odd series state) — nothing
      // to clamp onto.
      return null
    }
    const arr = getCandles()
    if (!arr || arr.length < 13 || !res?.priceRange) return res
    const flags = detectLocalOutliers(arr)
    let flagged = 0
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < arr.length; i++) {
      if (flags[i]) { flagged++; continue }
      if (arr[i].low < min) min = arr[i].low
      if (arr[i].high > max) max = arr[i].high
    }
    // Nothing excluded, or everything was (degenerate feed) — trust the
    // library's own computation.
    if (flagged === 0 || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) return res
    return { priceRange: { minValue: min, maxValue: max }, margins: res.margins }
  }
}

type WatermarkAlign = { horz: 'left' | 'right' | HorzAlign; vert: 'top' | 'bottom' | VertAlign }

const WM_PLACES: Record<string, WatermarkAlign> = {
  'center-center': { horz: 'center', vert: 'center' },
  'center-top': { horz: 'center', vert: 'top' },
  'center-bottom': { horz: 'center', vert: 'bottom' },
  'left-center': { horz: 'left', vert: 'center' },
  'right-center': { horz: 'right', vert: 'center' },
}

/** watermark primitive — scalpboard's Qn() ($c: watermark, $e: pattern, $t: place, $s: size) */
export function applyWatermark(chart: IChartApi, s: ChartSettings, ticker: string): ITextWatermarkPluginApi<unknown> | null {
  const panes = chart.panes()
  if (panes.length === 0 || s.watermark <= 0 || !s.watermarkPattern) return null
  const pane = panes[0]
  const place = WM_PLACES[s.watermarkPlace] ?? WM_PLACES['center-center']
  const text = s.watermarkPattern.replaceAll('{ticker}', ticker || '')
  const fontSize = Math.max(4, s.watermarkSize)
  return createTextWatermark(pane as never, {
    visible: true,
    horzAlign: place.horz as HorzAlign,
    vertAlign: place.vert as VertAlign,
    lines: text.split('\n').map((ln) => ({
      text: ln,
      color: hexToRgba(At('--foreground-full', '#f2f2f2'), s.watermark),
      fontSize,
    })),
  }) as ITextWatermarkPluginApi<unknown>
}

/** volume pane height in % of the whole chart (scalpboard's volumesHeight) */
export function volumePaneTop(volumesHeight: number): number {
  return 1 - volumesHeight / 100
}

export function timeVisibleFor(tf: string): boolean {
  return tf !== '1d' && tf !== '1w'
}

export function secondsVisibleFor(tf: string): boolean {
  return timeVisibleFor(tf) && windowSeconds(tf) < 60
}
