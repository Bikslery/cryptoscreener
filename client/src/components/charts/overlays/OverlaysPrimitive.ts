import type {
  IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'
import type { OverlaysData } from '../../../services/chart-overlays'
import { At } from '../../../services/chart-config'
import { formatCompact } from '../../../utils/format'

/**
 * Peaks/cascades renderer — a verbatim port of scalpboard's `labled_line`
 * painter + figures lib (extracted from their production bundle
 * `DuwwQn7y.js`):
 *
 *  painter (`labled_line`):
 *    - if no coords or e[0].x > paneWidth -> skip
 *    - A = text.length*6 + 8 + 8 (approx text width, no measuring)
 *    - p = lastDataX + 32 + A < width ? width - A : lastDataX + 32
 *    - color m = baseline==="top" ? schemes[colorscheme].upColor
 *                                  : schemes[colorscheme].downColor
 *    - 1px line from (x0, y0) to (p, y0), horizontal -> y+0.5 crisp offset
 *    - 3x3 dot at (x0-1, y0-1) filled m
 *    - label box: attrs.y = baseline "bottom" ? y0+1 : y0
 *        box.y = attrs.y (top) | attrs.y - (4+10+3) (bottom)
 *        box.w = 4 + round(measure(text)) + 4, box.h = 17
 *        fill = m+"20", border 1px m (centered: +0.5,-1), radius 0
 *        text at (box.x+4, box.y+4) font 300 10px JetBrains Mono,
 *        color = figures.text.color, maxWidth = box.w - 8
 *    - drawPrice label on hover/selected only (not implemented)
 *
 *  colorschemes (chart options `other`):
 *    peak:    upColor = downColor = --chart--peak (#4d4d4d)
 *    baseline: cascades l->top, h->bottom
 */
interface LineSpec {
  time: number
  price: number
  text: string
  baseline: 'top' | 'bottom'
}

const BOX_PAD_X = 4
const BOX_PAD_TOP = 4
const BOX_PAD_BOTTOM = 3
const FONT_SIZE = 10
const BOX_H = BOX_PAD_TOP + FONT_SIZE + BOX_PAD_BOTTOM
const FONT = 'JetBrains Mono, ui-monospace, monospace'

/** #rrggbb -> rgba with the given opacity (hex colors come from CSS vars) */
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

export class OverlaysPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null
  private _series: ISeriesApi<SeriesType> | null = null
  private _requestUpdate: (() => void) | null = null
  private _data: OverlaysData | null = null
  private _lastDataTime: number | null = null
  private _pricePrecision = 2
  private _view: OverlaysPaneView

  constructor() {
    this._view = new OverlaysPaneView(this)
  }

  update(data: OverlaysData | null, lastDataTime: number | null, pricePrecision: number): void {
    this._data = data
    this._lastDataTime = lastDataTime
    this._pricePrecision = pricePrecision
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
  data(): OverlaysData | null { return this._data }
  lastDataTime(): number | null { return this._lastDataTime }
  pricePrecision(): number { return this._pricePrecision }
}

interface CanvasTarget {
  useMediaCoordinateSpace(cb: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void): void
}

class OverlaysPaneView implements IPrimitivePaneView {
  private _primitive: OverlaysPrimitive

  constructor(primitive: OverlaysPrimitive) {
    this._primitive = primitive
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

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width
      const specs = this._buildSpecs(data)
      if (specs.length === 0) return

      const render = data.render
      const opacity = Math.max(0, Math.min(100, render.opacity)) / 100
      const lineWidth = Math.max(1, Math.min(3, render.lineWidth))

      const timeScale = chart.timeScale()
      const peak = withAlpha(At('--chart--peak', '#4d4d4d'), opacity)
      const textColor = At('--foreground', '#cccccc')

      ctx.font = `300 ${FONT_SIZE}px ${FONT}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.lineWidth = lineWidth

      const lastDataX = (() => {
        const lt = this._primitive.lastDataTime()
        if (lt === null) return 0
        const x = timeScale.timeToCoordinate(lt as Time)
        return x === null ? 0 : x
      })()

      for (const s of specs) {
        const x0 = timeScale.timeToCoordinate(s.time as Time)
        const y0 = series.priceToCoordinate(s.price)
        if (x0 === null || y0 === null || !isFinite(x0) || !isFinite(y0)) continue
        if (x0 > width) continue

        const color = peak

        const A = s.text.length * 6 + 8 + 8
        const p = lastDataX + 32 + A < width ? width - A : lastDataX + 32

        // 1px horizontal line (y+0.5 crisp offset, scalpboard's Pb())
        ctx.strokeStyle = color
        ctx.beginPath()
        ctx.moveTo(x0, y0 + 0.5)
        ctx.lineTo(p, y0 + 0.5)
        ctx.stroke()

        // 3x3 start marker
        ctx.fillStyle = color
        ctx.fillRect(x0 - 1, y0 - 1, 3, 3)

        if (!render.showLabels) continue

        // label box (figures lib Ah() + fh())
        const textY = s.baseline === 'bottom' ? y0 + 1 : y0
        const boxY = s.baseline === 'bottom' ? textY - BOX_H : textY
        const textW = Math.round(ctx.measureText(s.text).width)
        const boxW = BOX_PAD_X + textW + BOX_PAD_X

        ctx.fillStyle = withAlpha(color, opacity * 0.125)
        ctx.fillRect(p, boxY, boxW, BOX_H)
        ctx.strokeStyle = color
        ctx.strokeRect(p + 0.5, boxY + 0.5, boxW - 1, BOX_H - 1)

        ctx.fillStyle = textColor
        ctx.fillText(s.text, p + BOX_PAD_X, boxY + BOX_PAD_TOP, boxW - BOX_PAD_X * 2)
      }
      ctx.textBaseline = 'alphabetic'
    })
  }

  private _buildSpecs(data: OverlaysData): LineSpec[] {
    const specs: LineSpec[] = []
    for (const side of ['h', 'l'] as const) {
      for (const cascade of data.cascades[side]) {
        const baseline: 'top' | 'bottom' = side === 'l' ? 'top' : 'bottom'
        for (const peak of cascade) {
          specs.push({
            time: peak.t,
            price: peak.e,
            text: formatCompact(peak.c),
            baseline,
          })
        }
      }
    }
    return specs
  }
}