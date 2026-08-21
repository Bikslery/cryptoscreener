import type {
  IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'
import { toChartTime } from '../../../services/candle-events'

/**
 * Density (orderbook walls) renderer — horizontal lines at wall prices,
 * drawn from the wall's BIRTH TIME on the time axis to the right pane edge,
 * with a right-anchored label (exchange badge, size, price). Colors come
 * from the density scheme (bid green / ask red), styled after scalpboard's
 * `labled_line` figure.
 */
export interface DensityLineSpec {
  price: number
  /** момент рождения стены, unix-секунды (wall.bornAt / 1000) */
  birthTimeSec: number
  color: string
  text: string
  baseline: 'top' | 'bottom'
}

const BOX_PAD_X = 4
const BOX_PAD_TOP = 4
const BOX_PAD_BOTTOM = 3
const FONT_SIZE = 10
const BOX_H = BOX_PAD_TOP + FONT_SIZE + BOX_PAD_BOTTOM
const FONT = "'JetBrains Mono Variable', ui-monospace, monospace"

/**
 * Index of the bar that CONTAINS `birthChartSec` — the last bar whose time
 * is <= the birth moment (the candle that was forming when the wall was
 * created, chart-time space). Returns -1 when the birth predates every bar
 * (the caller then anchors to the first bar instead). Binary search keeps
 * this exact even when the birth falls into a data gap: instead of a
 * floor-snapped time that `timeToCoordinate` cannot map (it returns null for
 * non-bar-aligned times), the marker lands on a real bar, so the density's
 * first point always sits on (or right after) its creation date.
 */
export function birthBarIndex(times: readonly number[], birthChartSec: number): number {
  if (times.length === 0) return -1
  if (birthChartSec < times[0]) return -1
  let lo = 0
  let hi = times.length - 1
  let anchor = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= birthChartSec) {
      anchor = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return anchor
}

function withAlpha(color: string, alpha: number): string {
  if (alpha >= 0.999) return color
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

export class DensityPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null
  private _series: ISeriesApi<SeriesType> | null = null
  private _requestUpdate: (() => void) | null = null
  private _data: DensityLineSpec[] | null = null
  private _view: DensityPaneView

  constructor() {
    this._view = new DensityPaneView(this)
  }

  update(data: DensityLineSpec[] | null): void {
    this._data = data
    this._requestUpdate?.()
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart as IChartApi
    this._series = param.series as ISeriesApi<SeriesType>
    this._requestUpdate = param.requestUpdate
    this._requestUpdate()
  }

  detached(): void {
    this._chart = null
    this._series = null
    this._requestUpdate = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._view]
  }

  chart(): IChartApi | null { return this._chart }
  series(): ISeriesApi<SeriesType> | null { return this._series }
  data(): DensityLineSpec[] | null { return this._data }
}

interface CanvasTarget {
  useMediaCoordinateSpace(cb: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void): void
}

const EMPTY_TIMES: readonly number[] = []

class DensityPaneView implements IPrimitivePaneView {
  private _primitive: DensityPrimitive
  /** Bar timeline cache — rebuilding `sd.map(b => b.time)` inside _draw
   *  allocated a fresh array on EVERY paint frame (pan/zoom/crosshair).
   *  Invalidated by length + first/last time, which covers history loads,
   *  appends and lazy-scroll prepends. */
  private _barTimesCache: { times: number[]; len: number; first: number; last: number } | null = null

  constructor(primitive: DensityPrimitive) {
    this._primitive = primitive
  }

  private getBarTimes(series: ISeriesApi<SeriesType>): readonly number[] {
    const sd = series.data()
    if (sd.length === 0) return EMPTY_TIMES
    const first = sd[0].time as number
    const last = sd[sd.length - 1].time as number
    const c = this._barTimesCache
    if (c && c.len === sd.length && c.first === first && c.last === last) return c.times
    const times = sd.map(b => b.time as number)
    this._barTimesCache = { times, len: sd.length, first, last }
    return times
  }

  zOrder(): 'top' {
    return 'top'
  }

  renderer(): IPrimitivePaneRenderer {
    return { draw: (target) => this._draw(target as CanvasTarget) }
  }

  private _draw(target: CanvasTarget): void {
    const chart = this._primitive.chart()
    const series = this._primitive.series()
    const data = this._primitive.data()
    if (!chart || !series || !data) return

    // A primitive renderer runs inside the chart's paint loop — an exception
    // here aborts the frame and can break the whole pane. Guard defensively.
    try {
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width
      ctx.font = `300 ${FONT_SIZE}px ${FONT}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'

      // Bar timeline (chart-time space) — used to anchor a wall's birth to
      // the bar that contains its creation moment (cached between frames).
      const barTimes = this.getBarTimes(series)
      if (barTimes.length === 0) return

      // Hoisted out of the wall loop — the API call itself is trivial but it
      // ran once per wall per frame.
      const timeScale = chart.timeScale()

      for (const s of data) {
        const y0 = series.priceToCoordinate(s.price)
        if (y0 === null || !isFinite(y0)) { continue }

        // The candle series paints SHIFTED times (toChartTime — local-tz
        // offset), so the wall's birth time must be asked in the same space.
        // v5.2.0's timeToCoordinate has no findNearest: it returns null for
        // any non-bar-aligned time, so anchor the birth to the CONTAINING
        // bar (scalpboard semantics: the line starts at the birth bar).
        const birthChartSec = toChartTime(s.birthTimeSec)
        const birthIdx = birthBarIndex(barTimes, birthChartSec)
        const anchor = birthIdx >= 0 ? birthIdx : 0
        const rawX = timeScale.timeToCoordinate(barTimes[anchor] as Time)
        let x0: number
        if (rawX !== null && isFinite(rawX)) {
          x0 = rawX
        } else {
          // Birth before the visible range (or before the first bar) — the
          // line starts at the left pane edge.
          const range = timeScale.getVisibleRange()
          if (!range || birthChartSec >= (range.from as number)) { continue }
          x0 = 0
        }

        const A = s.text.length * 6 + 8 + 8
        const p = width - A
        if (x0 > p) { continue }

        ctx.lineWidth = 1
        ctx.strokeStyle = s.color
        ctx.beginPath()
        ctx.moveTo(Math.max(0, x0), y0 + 0.5)
        ctx.lineTo(p, y0 + 0.5)
        ctx.stroke()

        // small marker at the birth point
        ctx.fillStyle = s.color
        ctx.fillRect(Math.max(0, x0) - 1, y0 - 1, 3, 3)

        // label box (figures lib Ah() + fh())
        const textY = s.baseline === 'bottom' ? y0 + 1 : y0
        const boxY = s.baseline === 'bottom' ? textY - BOX_H : textY
        const textW = Math.round(ctx.measureText(s.text).width)
        const boxW = BOX_PAD_X + textW + BOX_PAD_X

        ctx.fillStyle = withAlpha(s.color, 0.12)
        ctx.fillRect(p, boxY, boxW, BOX_H)
        ctx.strokeStyle = s.color
        ctx.strokeRect(p + 0.5, boxY + 0.5, boxW - 1, BOX_H - 1)

        ctx.fillStyle = '#cccccc'
        ctx.fillText(s.text, p + BOX_PAD_X, boxY + BOX_PAD_TOP, boxW - BOX_PAD_X * 2)
      }
      ctx.textBaseline = 'alphabetic'
      })
    } catch (e) {
      console.error('[density-primitive] draw error:', e)
    }
  }
}
