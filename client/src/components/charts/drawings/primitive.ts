import { LineStyle } from 'lightweight-charts'
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  PrimitiveHoveredItem,
  DrawingUtils,
  Time,
  Logical,
  SeriesType,
} from 'lightweight-charts'
import type { Drawing, HRayDrawing, TRayDrawing, SegmentDrawing, RectDrawing, FibDrawing, CircleDrawing, UnifiedCandle } from '../../../types'

interface CanvasTarget {
  useMediaCoordinateSpace(cb: (scope: { context: CanvasRenderingContext2D }) => void): void
}

interface HRayItem {
  type: 'h-ray'
  id: string
  x: number
  y: number
  price: number
  /** Price-alert rays (dashed data) render amber with a dotted pattern. */
  dashed?: boolean
}

interface TRayItem {
  type: 't-ray'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  endX: number
  endY: number
}

interface SegmentItem {
  type: 'segment'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

interface RectItem {
  type: 'rect'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

interface FibItem {
  type: 'fib'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  price1: number
  price2: number
}

interface CircleItem {
  type: 'circle'
  id: string
  cx: number
  cy: number
  r: number
  x2: number
  y2: number
}

interface PreviewItem {
  type: 'line' | 'rect' | 'fib' | 'circle'
  x1: number
  y1: number
  x2: number
  y2: number
}

interface PendingItem {
  x: number
  y: number
}

type DrawItem = HRayItem | TRayItem | SegmentItem | RectItem | FibItem | CircleItem

export interface HitTestResult {
  id: string
  pointIndex: number | null
  distance: number
}

const ENDPOINT_RADIUS = 5
const HIT_DIST_LINE = 6
const HIT_DIST_POINT = 8
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

export function findBarByTime(
  candleData: ReadonlyArray<UnifiedCandle> | null | undefined,
  targetTime: number,
): number | null {
  if (!candleData || candleData.length === 0) return null
  if (!Number.isFinite(targetTime)) return null

  const first = candleData[0]
  const last = candleData[candleData.length - 1]
  if (targetTime < first.time) return null

  let lo = 0
  let hi = candleData.length - 1

  if (targetTime >= last.time) return hi

  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (candleData[mid].time <= targetTime) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return lo
}

function sanitizeTime(time: unknown): number | null {
  if (time == null) return null
  if (typeof time === 'number') {
    return Number.isFinite(time) ? time : null
  }
  if (typeof time === 'string') {
    const parsed = Date.parse(time)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
  }
  if (typeof time === 'object') {
    const o = time as { year?: unknown; month?: unknown; day?: unknown }
    if (typeof o.year === 'number' && typeof o.month === 'number' && typeof o.day === 'number') {
      return Math.floor(Date.UTC(o.year, o.month - 1, o.day) / 1000)
    }
  }
  return null
}

export function timeToPixel(
  chart: IChartApi,
  candleData: ReadonlyArray<UnifiedCandle> | null | undefined,
  time: Time,
): number | null {
  const timeNum = sanitizeTime(time)
  if (timeNum === null) return null

  const cached = chart.timeScale().timeToCoordinate(time as Time)
  if (cached !== null) return cached

  const barIndex = findBarByTime(candleData, timeNum)
  if (barIndex === null) return null

  return chart.timeScale().logicalToCoordinate(barIndex as Logical)
}

export function logicalToTime(
  candleData: ReadonlyArray<UnifiedCandle> | null | undefined,
  logical: number,
): number | null {
  if (!Number.isFinite(logical)) return null
  if (!candleData || candleData.length === 0) return null
  const idx = Math.floor(logical)
  if (idx >= 0 && idx < candleData.length) return candleData[idx].time
  const first = candleData[0]
  const last = candleData[candleData.length - 1]
  const secondsPerBar = candleData.length > 1
    ? (last.time - first.time) / (candleData.length - 1)
    : 0
  return Math.round(first.time + logical * secondsPerBar)
}

export function resolveExactX(
  chart: IChartApi,
  candleData: ReadonlyArray<UnifiedCandle> | null | undefined,
  time: Time,
  logical?: number,
): number | null {
  if (logical != null && Number.isFinite(logical)) {
    const x = chart.timeScale().logicalToCoordinate(logical as Logical)
    if (x !== null) return x
  }
  return timeToPixel(chart, candleData, time)
}

class HRayPriceAxisView implements ISeriesPrimitiveAxisView {
  private _price: number
  private _y: number
  private _precision: number

  constructor(price: number, y: number, precision: number) {
    this._price = price
    this._y = y
    this._precision = precision
  }

  coordinate(): number { return this._y }
  fixedCoordinate(): number { return this._y }
  text(): string { return this._price.toFixed(this._precision) }
  textColor(): string { return '#ffffff' }
  backColor(): string { return '#1a1a1a' }
  visible(): boolean { return true }
  tickVisible(): boolean { return true }
}

class DrawingsRenderer implements IPrimitivePaneRenderer {
  private _items: DrawItem[] = []
  private _preview: PreviewItem | null = null
  private _pending: PendingItem | null = null
  private _cw = 0
  private _pricePrecision = 2
  private _hoveredId: string | null = null

  setItems(items: DrawItem[], cw: number, ch: number, pricePrecision: number) {
    this._items = items
    this._cw = cw
    void ch
    this._pricePrecision = pricePrecision
  }

  setPreview(preview: PreviewItem | null) {
    this._preview = preview
  }

  setPending(pending: PendingItem | null) {
    this._pending = pending
  }

  setHoveredId(id: string | null) {
    this._hoveredId = id
  }

  draw(target: CanvasTarget, utils?: DrawingUtils) {
    if (this._items.length === 0 && !this._preview && !this._pending) return

    target.useMediaCoordinateSpace(({ context }) => {
      context.save()
      context.strokeStyle = '#ffffff'
      context.fillStyle = '#ffffff'
      context.lineWidth = 1
      context.font = "10px 'JetBrains Mono', monospace"

      for (const item of this._items) {
        const isHovered = this._hoveredId === item.id
        // Price-alert rays (dashed) are amber to stand out from plain rays.
        const baseColor = item.type === 'h-ray' && item.dashed ? '#f5c518' : '#ffffff'
        const strokeColor = isHovered ? '#7eb8ff' : baseColor
        const lineWidth = isHovered ? 2 : 1

        if (item.type === 'h-ray') {
          context.strokeStyle = strokeColor
          context.lineWidth = lineWidth
          if (item.dashed) context.setLineDash([4, 4])
          context.beginPath()
          context.moveTo(item.x, item.y)
          context.lineTo(this._cw, item.y)
          context.stroke()
          context.setLineDash([])

          this.drawEndpoint(context, item.x, item.y, strokeColor)

          context.fillStyle = strokeColor
          context.textAlign = 'right'
          context.fillText(item.price.toFixed(this._pricePrecision), this._cw - 6, item.y - 6)
          context.textAlign = 'start'
        }

        if (item.type === 't-ray') {
          context.strokeStyle = strokeColor
          context.lineWidth = lineWidth
          context.beginPath()
          context.moveTo(item.x1, item.y1)
          context.lineTo(item.endX, item.endY)
          context.stroke()

          this.drawEndpoint(context, item.x1, item.y1, strokeColor)
          this.drawEndpoint(context, item.x2, item.y2, strokeColor)
        }

        if (item.type === 'segment') {
          context.strokeStyle = strokeColor
          context.lineWidth = lineWidth
          context.beginPath()
          context.moveTo(item.x1, item.y1)
          context.lineTo(item.x2, item.y2)
          context.stroke()

          this.drawEndpoint(context, item.x1, item.y1, strokeColor)
          this.drawEndpoint(context, item.x2, item.y2, strokeColor)
        }

        if (item.type === 'rect') {
          context.strokeStyle = strokeColor
          context.lineWidth = lineWidth
          context.strokeRect(
            Math.min(item.x1, item.x2),
            Math.min(item.y1, item.y2),
            Math.abs(item.x2 - item.x1),
            Math.abs(item.y2 - item.y1),
          )

          this.drawEndpoint(context, item.x1, item.y1, strokeColor)
          this.drawEndpoint(context, item.x2, item.y2, strokeColor)
        }

        if (item.type === 'fib') {
          context.strokeStyle = strokeColor
          context.lineWidth = lineWidth

          for (let i = 0; i < FIB_LEVELS.length; i++) {
            const t = FIB_LEVELS[i]
            const ly = item.y1 + (item.y2 - item.y1) * t
            const price = item.price1 + (item.price2 - item.price1) * t
            context.globalAlpha = i === 0 || i === FIB_LEVELS.length - 1 ? 1 : 0.55
            context.beginPath()
            context.moveTo(Math.min(item.x1, item.x2), ly)
            context.lineTo(this._cw, ly)
            context.stroke()

            context.globalAlpha = 1
            context.fillStyle = strokeColor
            context.font = "9px 'JetBrains Mono', monospace"
            context.textAlign = 'right'
            context.fillText(price.toFixed(this._pricePrecision), this._cw - 6, ly - 3)
            context.textAlign = 'start'
          }

          this.drawEndpoint(context, item.x1, item.y1, strokeColor)
          this.drawEndpoint(context, item.x2, item.y2, strokeColor)
        }

        if (item.type === 'circle') {
          context.strokeStyle = strokeColor
          context.lineWidth = lineWidth
          context.beginPath()
          context.arc(item.cx, item.cy, item.r, 0, Math.PI * 2)
          context.stroke()

          this.drawEndpoint(context, item.cx, item.cy, strokeColor)
          this.drawEndpoint(context, item.x2, item.y2, strokeColor)
        }
      }

      context.strokeStyle = '#ffffff'
      context.fillStyle = '#ffffff'
      context.lineWidth = 1

      if (this._preview) {
        if (utils?.setLineStyle) {
          utils.setLineStyle(context, LineStyle.Dashed)
        } else {
          context.setLineDash([4, 3])
        }
        context.strokeStyle = 'rgba(255,255,255,0.5)'
        if (this._preview.type === 'line') {
          context.beginPath()
          context.moveTo(this._preview.x1, this._preview.y1)
          context.lineTo(this._preview.x2, this._preview.y2)
          context.stroke()
        }
        if (this._preview.type === 'rect') {
          context.strokeRect(
            Math.min(this._preview.x1, this._preview.x2),
            Math.min(this._preview.y1, this._preview.y2),
            Math.abs(this._preview.x2 - this._preview.x1),
            Math.abs(this._preview.y2 - this._preview.y1),
          )
        }
        if (this._preview.type === 'circle') {
          context.beginPath()
          context.arc(
            this._preview.x1,
            this._preview.y1,
            Math.hypot(this._preview.x2 - this._preview.x1, this._preview.y2 - this._preview.y1),
            0,
            Math.PI * 2,
          )
          context.stroke()
        }
        if (utils?.setLineStyle) {
          utils.setLineStyle(context, LineStyle.Solid)
        } else {
          context.setLineDash([])
        }
        context.strokeStyle = '#ffffff'
      }

      if (this._pending) {
        this.drawEndpoint(context, this._pending.x, this._pending.y, '#ffffff')
      }

      context.restore()
    })
  }

  private drawEndpoint(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
    ctx.beginPath()
    ctx.arc(x, y, ENDPOINT_RADIUS - 2, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = '#0e0e0e'
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

class DrawingsView implements IPrimitivePaneView {
  private _renderer: DrawingsRenderer

  constructor(renderer: DrawingsRenderer) {
    this._renderer = renderer
  }

  zOrder() {
    return 'top' as const
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer
  }
}

export class DrawingsPrimitive implements ISeriesPrimitive {
  private _drawings: Drawing[] = []
  private _chart: IChartApi | null = null
  private _series: ISeriesApi<SeriesType> | null = null
  private _candleData: ReadonlyArray<UnifiedCandle> | null = null
  private _pricePrecision = 2
  private _onRemove: ((id: string) => void) | null = null
  private _onUpdateDrawing: ((id: string, data: unknown) => void) | null = null
  private _requestUpdate: (() => void) | null = null
  private _renderer: DrawingsRenderer
  private _view: DrawingsView
  private _items: DrawItem[] = []
  private _priceAxisViewCache: readonly ISeriesPrimitiveAxisView[] = []
  private _cw = 0
  private _ch = 0
  private _disposed = false

  constructor() {
    this._renderer = new DrawingsRenderer()
    this._view = new DrawingsView(this._renderer)
  }

  setDrawings(
    drawings: Drawing[],
    chart: IChartApi | null,
    series: ISeriesApi<SeriesType> | null,
    cw: number,
    ch: number,
    pricePrecision: number,
    candleData: ReadonlyArray<UnifiedCandle> | null,
    onRemove: (id: string) => void,
    onUpdateDrawing?: (id: string, data: unknown) => void,
  ) {
    this._drawings = drawings.filter(
      d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment' || d.type === 'rect' || d.type === 'fib' || d.type === 'circle'
    )
    this._chart = chart
    this._series = series
    this._candleData = candleData
    this._cw = cw
    this._ch = ch
    this._pricePrecision = pricePrecision
    this._onRemove = onRemove
    this._onUpdateDrawing = onUpdateDrawing ?? null
    this.rebuildItems()
  }

  setPreview(preview: PreviewItem | null) {
    this._renderer.setPreview(preview)
    this.requestUpdate()
  }

  setPendingPoint(pending: PendingItem | null) {
    this._renderer.setPending(pending)
    this.requestUpdate()
  }

  setHoveredId(id: string | null) {
    this._renderer.setHoveredId(id)
    this.requestUpdate()
  }

  updateDrawingData(id: string, data: unknown) {
    const idx = this._drawings.findIndex(d => d.id === id)
    if (idx === -1) return
    this._drawings[idx] = { ...this._drawings[idx], data: data as Drawing['data'] }
    this.rebuildItems()
    this.requestUpdate()
  }

  shiftLogical(added: number, candleData: ReadonlyArray<UnifiedCandle> | null) {
    if (added === 0) return
    this._candleData = candleData
    this._drawings = this._drawings.map(d => {
      if (d.type === 'h-ray') {
        const data = d.data as HRayDrawing
        if (data.logical == null) return d
        const newLogical = data.logical + added
        const newTime = logicalToTime(candleData, newLogical) ?? data.time
        return { ...d, data: { ...data, logical: newLogical, time: newTime } }
      }
      if (d.type === 't-ray' || d.type === 'segment' || d.type === 'rect' || d.type === 'fib' || d.type === 'circle') {
        const data = d.data as TRayDrawing | SegmentDrawing | RectDrawing | FibDrawing | CircleDrawing
        const newFromLogical = data.fromLogical != null ? data.fromLogical + added : data.fromLogical
        const newToLogical = data.toLogical != null ? data.toLogical + added : data.toLogical
        const newFromTime = newFromLogical != null ? (logicalToTime(candleData, newFromLogical) ?? data.fromTime) : data.fromTime
        const newToTime = newToLogical != null ? (logicalToTime(candleData, newToLogical) ?? data.toTime) : data.toTime
        return { ...d, data: { ...data, fromLogical: newFromLogical, toLogical: newToLogical, fromTime: newFromTime, toTime: newToTime } }
      }
      return d
    })
  }

  commitDrawingUpdate(id: string, data: unknown) {
    if (this._onUpdateDrawing) {
      this._onUpdateDrawing(id, data)
    }
  }

  updateAllViews?() {
    // Sync container dims from the chart on EVERY view update — the cached
    // _cw/_ch from setDrawings go stale on window resize / panel collapse,
    // making h-rays stop at the old right edge and t-rays clip at the old
    // bottom. chart.options().width/height are always current in v5.
    if (this._chart) {
      const opts = this._chart.options()
      if (typeof opts.width === 'number' && opts.width > 0) this._cw = opts.width
      if (typeof opts.height === 'number' && opts.height > 0) this._ch = opts.height
    }
    this.rebuildItems()
  }

  paneViews?(): readonly IPrimitivePaneView[] {
    return [this._view]
  }

  priceAxisViews?(): readonly ISeriesPrimitiveAxisView[] {
    const views: ISeriesPrimitiveAxisView[] = []
    for (const item of this._items) {
      if (item.type === 'h-ray') {
        views.push(new HRayPriceAxisView(item.price, item.y, this._pricePrecision))
      }
    }
    const sameLength = views.length === this._priceAxisViewCache.length
    const allMatch = sameLength && views.every((v, i) => {
      const cached = this._priceAxisViewCache[i]
      return v.coordinate() === cached.coordinate() && v.text() === cached.text()
    })
    if (allMatch) return this._priceAxisViewCache
    this._priceAxisViewCache = views
    return views
  }


  attached?(param: SeriesAttachedParameter<Time, 'Candlestick'>) {
    this._chart = param.chart as IChartApi
    this._series = param.series as ISeriesApi<SeriesType>
    this._requestUpdate = param.requestUpdate
    this._disposed = false
  }

  detached?() {
    this._disposed = true
    this._chart = null
    this._series = null
    this._requestUpdate = null
  }

  hitTest?(x: number, y: number): PrimitiveHoveredItem | null {
    for (let i = this._items.length - 1; i >= 0; i--) {
      const item = this._items[i]
      const hit = this.hitTestItem(item, x, y)
      if (hit !== null) {
        const isEndpoint = hit.pointIndex !== null
        return {
          externalId: item.id,
          distance: hit.distance,
          hitTestPriority: isEndpoint ? 2 : 1,
          cursorStyle: isEndpoint ? 'grab' : 'pointer',
          zOrder: 'top',
          itemType: 'primitive',
        }
      }
    }
    return null
  }

  hitTestDetailed(x: number, y: number): HitTestResult | null {
    for (let i = this._items.length - 1; i >= 0; i--) {
      const item = this._items[i]
      const hit = this.hitTestItem(item, x, y)
      if (hit !== null) return hit
    }
    return null
  }

  requestUpdate() {
    if (this._disposed) return
    if (this._requestUpdate) {
      this._requestUpdate()
    }
  }

  removeDrawing(id: string) {
    if (this._onRemove) {
      this._onRemove(id)
    }
  }

  getDrawing(id: string): Drawing | null {
    return this._drawings.find(d => d.id === id) ?? null
  }

  getCandleData(): ReadonlyArray<UnifiedCandle> | null {
    return this._candleData
  }

  private rebuildItems() {
    const items: DrawItem[] = []
    const chart = this._chart
    const series = this._series
    if (!chart || !series) {
      this._items = items
      this._renderer.setItems(items, this._cw, this._ch, this._pricePrecision)
      return
    }

    const candleData = this._candleData

    for (const d of this._drawings) {
      if (d.type === 'h-ray') {
        const data = d.data as HRayDrawing
        const py = series.priceToCoordinate(data.price)
        const px = resolveExactX(chart, candleData, data.time as Time, data.logical)
        if (py === null || px === null) continue
        items.push({ type: 'h-ray', id: d.id, x: px, y: py, price: data.price, dashed: data.style === 'dashed' })
      }

      if (d.type === 't-ray') {
        const data = d.data as TRayDrawing
        const y1 = series.priceToCoordinate(data.fromPrice)
        const x1 = resolveExactX(chart, candleData, data.fromTime as Time, data.fromLogical)
        const y2 = series.priceToCoordinate(data.toPrice)
        const x2 = resolveExactX(chart, candleData, data.toTime as Time, data.toLogical)
        if (y1 === null || x1 === null || y2 === null || x2 === null) continue

        const dx = x2 - x1
        const dy = y2 - y1
        let endX = this._cw
        let endY: number = y2
        if (dx !== 0) {
          const t = (this._cw - x2) / dx
          endY = y2 + t * dy
        }

        if (endY < -50) {
          if (dy !== 0) {
            const t = (-50 - y2) / dy
            endX = x2 + t * dx
          }
          endY = -50
        } else if (endY > this._ch + 50) {
          if (dy !== 0) {
            const t = (this._ch + 50 - y2) / dy
            endX = x2 + t * dx
          }
          endY = this._ch + 50
        }

        items.push({ type: 't-ray', id: d.id, x1, y1, x2, y2, endX, endY })
      }

      if (d.type === 'segment') {
        const data = d.data as SegmentDrawing
        const y1 = series.priceToCoordinate(data.fromPrice)
        const x1 = resolveExactX(chart, candleData, data.fromTime as Time, data.fromLogical)
        const y2 = series.priceToCoordinate(data.toPrice)
        const x2 = resolveExactX(chart, candleData, data.toTime as Time, data.toLogical)
        if (y1 === null || x1 === null || y2 === null || x2 === null) continue
        items.push({ type: 'segment', id: d.id, x1, y1, x2, y2 })
      }

      if (d.type === 'rect') {
        const data = d.data as RectDrawing
        const y1 = series.priceToCoordinate(data.fromPrice)
        const x1 = resolveExactX(chart, candleData, data.fromTime as Time, data.fromLogical)
        const y2 = series.priceToCoordinate(data.toPrice)
        const x2 = resolveExactX(chart, candleData, data.toTime as Time, data.toLogical)
        if (y1 === null || x1 === null || y2 === null || x2 === null) continue
        items.push({ type: 'rect', id: d.id, x1, y1, x2, y2 })
      }

      if (d.type === 'fib') {
        const data = d.data as FibDrawing
        const y1 = series.priceToCoordinate(data.fromPrice)
        const x1 = resolveExactX(chart, candleData, data.fromTime as Time, data.fromLogical)
        const y2 = series.priceToCoordinate(data.toPrice)
        const x2 = resolveExactX(chart, candleData, data.toTime as Time, data.toLogical)
        if (y1 === null || x1 === null || y2 === null || x2 === null) continue
        items.push({ type: 'fib', id: d.id, x1, y1, x2, y2, price1: data.fromPrice, price2: data.toPrice })
      }

      if (d.type === 'circle') {
        const data = d.data as CircleDrawing
        const cy = series.priceToCoordinate(data.fromPrice)
        const cx = resolveExactX(chart, candleData, data.fromTime as Time, data.fromLogical)
        const y2 = series.priceToCoordinate(data.toPrice)
        const x2 = resolveExactX(chart, candleData, data.toTime as Time, data.toLogical)
        if (cy === null || cx === null || y2 === null || x2 === null) continue
        const r = Math.hypot(x2 - cx, y2 - cy)
        items.push({ type: 'circle', id: d.id, cx, cy, r, x2, y2 })
      }
    }

    this._items = items
    this._renderer.setItems(items, this._cw, this._ch, this._pricePrecision)
    this._priceAxisViewCache = []
  }

  private hitTestItem(item: DrawItem, mx: number, my: number): HitTestResult | null {
    if (item.type === 'h-ray') {
      const epDist = this.pointDist(mx, my, item.x, item.y)
      if (epDist <= HIT_DIST_POINT) {
        return { id: item.id, pointIndex: 0, distance: epDist }
      }
      if (Math.abs(my - item.y) <= HIT_DIST_LINE && mx >= item.x) {
        return { id: item.id, pointIndex: null, distance: Math.abs(my - item.y) }
      }
      return null
    }

    if (item.type === 't-ray') {
      const ep1Dist = this.pointDist(mx, my, item.x1, item.y1)
      const ep2Dist = this.pointDist(mx, my, item.x2, item.y2)
      if (ep1Dist <= HIT_DIST_POINT && ep1Dist <= ep2Dist) {
        return { id: item.id, pointIndex: 0, distance: ep1Dist }
      }
      if (ep2Dist <= HIT_DIST_POINT) {
        return { id: item.id, pointIndex: 1, distance: ep2Dist }
      }
      const ld = this.lineDist(mx, my, item.x1, item.y1, item.endX, item.endY)
      if (ld <= HIT_DIST_LINE) {
        return { id: item.id, pointIndex: null, distance: ld }
      }
      return null
    }

    if (item.type === 'segment' || item.type === 'rect' || item.type === 'fib') {
      const ep1Dist = this.pointDist(mx, my, item.x1, item.y1)
      const ep2Dist = this.pointDist(mx, my, item.x2, item.y2)
      if (ep1Dist <= HIT_DIST_POINT && ep1Dist <= ep2Dist) {
        return { id: item.id, pointIndex: 0, distance: ep1Dist }
      }
      if (ep2Dist <= HIT_DIST_POINT) {
        return { id: item.id, pointIndex: 1, distance: ep2Dist }
      }
      if (item.type === 'segment' || item.type === 'fib') {
        const ld = this.lineDist(mx, my, item.x1, item.y1, item.x2, item.y2)
        if (ld <= HIT_DIST_LINE) {
          return { id: item.id, pointIndex: null, distance: ld }
        }
      }
      if (item.type === 'rect') {
        const ld = Math.min(
          this.lineDist(mx, my, item.x1, item.y1, item.x2, item.y1),
          this.lineDist(mx, my, item.x2, item.y1, item.x2, item.y2),
          this.lineDist(mx, my, item.x2, item.y2, item.x1, item.y2),
          this.lineDist(mx, my, item.x1, item.y2, item.x1, item.y1),
        )
        if (ld <= HIT_DIST_LINE) {
          return { id: item.id, pointIndex: null, distance: ld }
        }
      }
      return null
    }

    if (item.type === 'circle') {
      const ep1Dist = this.pointDist(mx, my, item.cx, item.cy)
      const ep2Dist = this.pointDist(mx, my, item.x2, item.y2)
      if (ep1Dist <= HIT_DIST_POINT && ep1Dist <= ep2Dist) {
        return { id: item.id, pointIndex: 0, distance: ep1Dist }
      }
      if (ep2Dist <= HIT_DIST_POINT) {
        return { id: item.id, pointIndex: 1, distance: ep2Dist }
      }
      const ld = Math.abs(this.pointDist(mx, my, item.cx, item.cy) - item.r)
      if (ld <= HIT_DIST_LINE) {
        return { id: item.id, pointIndex: null, distance: ld }
      }
      return null
    }

    return null
  }

  private pointDist(x1: number, y1: number, x2: number, y2: number): number {
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)
  }

  private lineDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1
    const dy = y2 - y1
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) return this.pointDist(px, py, x1, y1)

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
    return this.pointDist(px, py, x1 + t * dx, y1 + t * dy)
  }
}
