import type {
  IChartApi,
  ISeriesApi,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  PrimitiveHoveredItem,
  Time,
  Logical,
} from 'lightweight-charts'
import type { Drawing, HRayDrawing, TRayDrawing, SegmentDrawing } from '../../../types'

interface CanvasTarget {
  useMediaCoordinateSpace(cb: (scope: { context: CanvasRenderingContext2D }) => void): void
}

interface HRayItem {
  type: 'h-ray'
  id: string
  x: number
  y: number
  price: number
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

type DrawItem = HRayItem | TRayItem | SegmentItem

function timeToPixel(
  chart: IChartApi,
  time: Time,
  logical?: number,
): number | null {
  const px = chart.timeScale().timeToCoordinate(time)
  if (px !== null) return px

  const visLogical = chart.timeScale().getVisibleLogicalRange()
  const visTime = chart.timeScale().getVisibleRange()
  if (!visLogical || !visTime) {
    if (logical != null && isFinite(logical)) {
      return chart.timeScale().logicalToCoordinate(logical as Logical)
    }
    return null
  }

  const lFrom = visLogical.from as number
  const lTo = visLogical.to as number
  const tFrom = visTime.from as number
  const tTo = visTime.to as number
  if (lTo === lFrom || !isFinite(tFrom) || !isFinite(tTo)) return null

  const timeNum = time as number
  if (!isFinite(timeNum)) return null

  const estLogical = lFrom + (timeNum - tFrom) * (lTo - lFrom) / (tTo - tFrom)
  if (!isFinite(estLogical)) return null

  return chart.timeScale().logicalToCoordinate(estLogical as Logical)
}

class DrawingsRenderer implements IPrimitivePaneRenderer {
  private _items: DrawItem[] = []
  private _cw = 0
  private _pricePrecision = 2

  setItems(items: DrawItem[], cw: number, ch: number, pricePrecision: number) {
    this._items = items
    this._cw = cw
    void ch
    this._pricePrecision = pricePrecision
  }

  draw(target: CanvasTarget) {
    if (this._items.length === 0) return

    target.useMediaCoordinateSpace(({ context }) => {
      context.save()
      context.strokeStyle = '#ffffff'
      context.fillStyle = '#ffffff'
      context.lineWidth = 1
      context.font = "10px 'Inter', sans-serif"

      for (const item of this._items) {
        if (item.type === 'h-ray') {
          context.beginPath()
          context.moveTo(item.x, item.y)
          context.lineTo(this._cw, item.y)
          context.stroke()

          context.beginPath()
          context.arc(item.x, item.y, 3, 0, Math.PI * 2)
          context.fillStyle = '#ffffff'
          context.fill()
          context.strokeStyle = '#0e0e0e'
          context.lineWidth = 1
          context.stroke()
          context.strokeStyle = '#ffffff'
          context.lineWidth = 1

          context.fillStyle = '#ffffff'
          context.textAlign = 'right'
          context.fillText(item.price.toFixed(this._pricePrecision), this._cw - 6, item.y - 6)
          context.textAlign = 'start'
        }

        if (item.type === 't-ray') {
          context.beginPath()
          context.moveTo(item.x1, item.y1)
          context.lineTo(item.endX, item.endY)
          context.stroke()

          context.beginPath()
          context.arc(item.x1, item.y1, 3, 0, Math.PI * 2)
          context.fillStyle = '#ffffff'
          context.fill()
          context.strokeStyle = '#0e0e0e'
          context.lineWidth = 1
          context.stroke()

          context.beginPath()
          context.arc(item.x2, item.y2, 3, 0, Math.PI * 2)
          context.fillStyle = '#ffffff'
          context.fill()
          context.strokeStyle = '#0e0e0e'
          context.lineWidth = 1
          context.stroke()
          context.strokeStyle = '#ffffff'
          context.lineWidth = 1
        }

        if (item.type === 'segment') {
          context.beginPath()
          context.moveTo(item.x1, item.y1)
          context.lineTo(item.x2, item.y2)
          context.stroke()

          context.beginPath()
          context.arc(item.x1, item.y1, 3, 0, Math.PI * 2)
          context.fillStyle = '#ffffff'
          context.fill()
          context.strokeStyle = '#0e0e0e'
          context.lineWidth = 1
          context.stroke()

          context.beginPath()
          context.arc(item.x2, item.y2, 3, 0, Math.PI * 2)
          context.fillStyle = '#ffffff'
          context.fill()
          context.strokeStyle = '#0e0e0e'
          context.lineWidth = 1
          context.stroke()
          context.strokeStyle = '#ffffff'
          context.lineWidth = 1
        }
      }

      context.restore()
    })
  }
}

class DrawingsView implements IPanePrimitivePaneView {
  private _renderer: DrawingsRenderer

  constructor(renderer: DrawingsRenderer) {
    this._renderer = renderer
  }

  zOrder() {
    return 'top' as const
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this._itemsVisible() ? this._renderer : null
  }

  private _itemsVisible(): boolean {
    return true
  }
}

export class DrawingsPrimitive implements IPanePrimitive {
  private _drawings: Drawing[] = []
  private _chart: IChartApi | null = null
  private _series: ISeriesApi<'Candlestick'> | null = null
  private _pricePrecision = 2
  private _onRemove: ((id: string) => void) | null = null
  private _requestUpdate: (() => void) | null = null
  private _renderer: DrawingsRenderer
  private _view: DrawingsView
  private _items: DrawItem[] = []
  private _cw = 0
  private _ch = 0

  constructor() {
    this._renderer = new DrawingsRenderer()
    this._view = new DrawingsView(this._renderer)
  }

  setDrawings(
    drawings: Drawing[],
    chart: IChartApi | null,
    series: ISeriesApi<'Candlestick'> | null,
    cw: number,
    ch: number,
    pricePrecision: number,
    onRemove: (id: string) => void,
  ) {
    this._drawings = drawings.filter(
      d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'
    )
    this._chart = chart
    this._series = series
    this._cw = cw
    this._ch = ch
    this._pricePrecision = pricePrecision
    this._onRemove = onRemove
    this.rebuildItems()
  }

  updateAllViews?() {
    this.rebuildItems()
  }

  paneViews?(): readonly IPanePrimitivePaneView[] {
    return [this._view]
  }

  attached?(param: PaneAttachedParameter<Time>) {
    this._chart = param.chart as IChartApi
    this._requestUpdate = param.requestUpdate
  }

  detached?() {
    this._chart = null
    this._requestUpdate = null
  }

  hitTest?(x: number, y: number): PrimitiveHoveredItem | null {
    const HIT_DIST = 6

    for (let i = this._items.length - 1; i >= 0; i--) {
      const item = this._items[i]
      const hit = this.hitTestItem(item, x, y, HIT_DIST)
      if (hit !== null) {
        return {
          externalId: item.id,
          distance: hit,
          hitTestPriority: 1,
          cursorStyle: 'pointer',
          zOrder: 'top',
          itemType: 'primitive',
        }
      }
    }

    return null
  }

  requestUpdate() {
    if (this._requestUpdate) {
      this._requestUpdate()
    }
  }

  removeDrawing(id: string) {
    if (this._onRemove) {
      this._onRemove(id)
    }
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

    for (const d of this._drawings) {
      if (d.type === 'h-ray') {
        const data = d.data as HRayDrawing
        const py = series.priceToCoordinate(data.price)
        const px = timeToPixel(chart, data.time as Time, data.logical)
        if (py === null || px === null) continue
        items.push({ type: 'h-ray', id: d.id, x: px, y: py, price: data.price })
      }

      if (d.type === 't-ray') {
        const data = d.data as TRayDrawing
        const y1 = series.priceToCoordinate(data.fromPrice)
        const x1 = timeToPixel(chart, data.fromTime as Time, data.fromLogical)
        const y2 = series.priceToCoordinate(data.toPrice)
        const x2 = timeToPixel(chart, data.toTime as Time, data.toLogical)
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
        const x1 = timeToPixel(chart, data.fromTime as Time, data.fromLogical)
        const y2 = series.priceToCoordinate(data.toPrice)
        const x2 = timeToPixel(chart, data.toTime as Time, data.toLogical)
        if (y1 === null || x1 === null || y2 === null || x2 === null) continue
        items.push({ type: 'segment', id: d.id, x1, y1, x2, y2 })
      }
    }

    this._items = items
    this._renderer.setItems(items, this._cw, this._ch, this._pricePrecision)
  }

  private hitTestItem(item: DrawItem, mx: number, my: number, dist: number): number | null {
    if (item.type === 'h-ray') {
      if (Math.abs(my - item.y) <= dist && mx >= item.x) return Math.abs(my - item.y)
      const cd = this.pointDist(mx, my, item.x, item.y)
      if (cd <= dist) return cd
      return null
    }

    if (item.type === 't-ray') {
      const ld = this.lineDist(mx, my, item.x1, item.y1, item.endX, item.endY)
      if (ld <= dist) return ld
      return null
    }

    if (item.type === 'segment') {
      const ld = this.lineDist(mx, my, item.x1, item.y1, item.x2, item.y2)
      if (ld <= dist) return ld
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
