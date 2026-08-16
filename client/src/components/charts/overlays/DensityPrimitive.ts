import type {
  IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'

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
const FONT = "'Noto Sans Variable', ui-sans-serif, sans-serif"

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
  private _pricePrecision = 2
  private _view: DensityPaneView

  constructor() {
    this._view = new DensityPaneView(this)
  }

  update(data: DensityLineSpec[] | null, pricePrecision: number): void {
    this._data = data
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
  data(): DensityLineSpec[] | null { return this._data }
  pricePrecision(): number { return this._pricePrecision }
}

interface CanvasTarget {
  useMediaCoordinateSpace(cb: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void): void
}

class DensityPaneView implements IPrimitivePaneView {
  private _primitive: DensityPrimitive

  constructor(primitive: DensityPrimitive) {
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
      ctx.font = `300 ${FONT_SIZE}px ${FONT}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'

      for (const s of data) {
        const y0 = series.priceToCoordinate(s.price)
        if (y0 === null || !isFinite(y0)) continue

        // Line starts when the wall was born. timeToCoordinate returns null
        // when the time maps outside the loaded data: if the birth is BEFORE
        // the visible range the line continues from the left edge, otherwise
        // (born in the future — impossible) it is skipped.
        const timeScale = chart.timeScale()
        const rawX = timeScale.timeToCoordinate(s.birthTimeSec as Time)
        let x0: number
        if (rawX !== null && isFinite(rawX)) {
          x0 = rawX
        } else {
          const range = timeScale.getVisibleRange()
          if (!range || s.birthTimeSec >= (range.from as number)) continue
          x0 = 0
        }

        const A = s.text.length * 6 + 8 + 8
        const p = width - A
        if (x0 > p) continue

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
  }
}
