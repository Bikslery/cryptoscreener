import { useState, useRef, useCallback, useEffect } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { Drawing, DrawingTool, HRayDrawing, TRayDrawing, SegmentDrawing, UnifiedCandle } from '../../types'
import api from '../../services/api'
import { useAuthStore, useCoinListStore } from '../../store'
import { useDrawingHotkeysStore } from '../../store/drawingHotkeys'
import { DrawingsPrimitive, resolveExactX, logicalToTime } from './drawings/primitive'

interface PendingPoint {
  price: number
  time: number
  logical?: number
}

interface DragState {
  drawingId: string
  pointIndex: number | null
  startMouseX: number
  startMouseY: number
  originalData: HRayDrawing | TRayDrawing | SegmentDrawing
}

const LOCAL_ID_PREFIX = 'local-'
let localCounter = 0

function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX)
}

function storageKey(symbol: string): string {
  return `drawings:${symbol}`
}

function loadFromStorage(symbol: string): Drawing[] {
  try {
    const raw = localStorage.getItem(storageKey(symbol))
    if (!raw) return []
    return JSON.parse(raw) as Drawing[]
  } catch {
    return []
  }
}

function saveToStorage(symbol: string, drawings: Drawing[]) {
  try {
    localStorage.setItem(storageKey(symbol), JSON.stringify(drawings))
  } catch {}
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n)
}

function isValidDrawingData(d: Drawing): boolean {
  if (!d || !d.data) return false
  if (d.type === 'h-ray') {
    const data = d.data as { price?: unknown; time?: unknown; logical?: unknown }
    return isFiniteNum(data.price) && isFiniteNum(data.time)
  }
  if (d.type === 't-ray' || d.type === 'segment') {
    const data = d.data as {
      fromPrice?: unknown; fromTime?: unknown;
      toPrice?: unknown; toTime?: unknown;
    }
    return isFiniteNum(data.fromPrice) && isFiniteNum(data.fromTime)
        && isFiniteNum(data.toPrice)   && isFiniteNum(data.toTime)
  }
  return false
}

function sanitizeDrawings(drawings: Drawing[]): Drawing[] {
  return drawings.filter(isValidDrawingData)
}

function computeUpdatedDrawingData(
  drawing: Drawing,
  pointIndex: number | null,
  price: number,
  time: number,
  logical: number | undefined,
  dragState: DragState,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  candleData: ReadonlyArray<UnifiedCandle> | null,
): HRayDrawing | TRayDrawing | SegmentDrawing {
  if (drawing.type === 'h-ray') {
    return { price, time, logical }
  }

  if (drawing.type === 't-ray' || drawing.type === 'segment') {
    const orig = dragState.originalData as TRayDrawing | SegmentDrawing

    if (pointIndex === 0) {
      return { ...orig, fromPrice: price, fromTime: time, fromLogical: logical }
    }
    if (pointIndex === 1) {
      return { ...orig, toPrice: price, toTime: time, toLogical: logical }
    }

    if (pointIndex === null) {
      const deltaY = dragState.startMouseY - (dragState.startMouseY + (series.coordinateToPrice(dragState.startMouseY)! - price))
      void deltaY

      const startPrice = series.coordinateToPrice(dragState.startMouseY) as number | null
      const currentPrice = price
      if (startPrice === null) return orig
      const deltaPrice = currentPrice - startPrice

      const startLogical = chart.timeScale().coordinateToLogical(dragState.startMouseX) as number | null
      const currentLogical = logical ?? 0
      if (startLogical === null) return orig
      const deltaLogical = currentLogical - startLogical

      const newFromPrice = (orig.fromPrice) + deltaPrice
      const newToPrice = (orig.toPrice) + deltaPrice
      const newFromLogical = (orig.fromLogical ?? 0) + deltaLogical
      const newToLogical = (orig.toLogical ?? 0) + deltaLogical

      const newFromTime = logicalToTime(candleData, newFromLogical) ?? orig.fromTime
      const newToTime = logicalToTime(candleData, newToLogical) ?? orig.toTime

      return {
        fromPrice: newFromPrice,
        fromTime: newFromTime,
        fromLogical: newFromLogical,
        toPrice: newToPrice,
        toTime: newToTime,
        toLogical: newToLogical,
      }
    }
  }

  return drawing.data as HRayDrawing | TRayDrawing | SegmentDrawing
}

export function useDrawings(
  symbol: string,
  tf: string,
  chartRef: React.RefObject<IChartApi | null>,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  chartVersion: number,
  isInitialLoading: boolean,
) {
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const activeTool = useDrawingHotkeysStore(s => s.activeTool)
  const setActiveTool = useDrawingHotkeysStore(s => s.activateTool)
  const [pendingPoint, setPendingPoint] = useState<PendingPoint | null>(null)
  const isLoggedIn = useAuthStore(s => s.isLoggedIn)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)

  const drawingsRef = useRef(drawings)
  drawingsRef.current = drawings

  const activeToolRef = useRef<DrawingTool | null>(activeTool)
  activeToolRef.current = activeTool

  const deactivateGlobal = useDrawingHotkeysStore(s => s.deactivate)

  const pendingPointRef = useRef(pendingPoint)
  pendingPointRef.current = pendingPoint

  const primitiveRef = useRef<DrawingsPrimitive | null>(null)

  const symbolRef = useRef(symbol)
  symbolRef.current = symbol

  const dragStateRef = useRef<DragState | null>(null)
  const isDraggingRef = useRef(false)
  const hoveredIdRef = useRef<string | null>(null)

  useEffect(() => {
    const reqSymbol = symbol
    const stored = sanitizeDrawings(loadFromStorage(reqSymbol)).filter(
      d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'
    )
    setDrawings(stored)

    if (!isLoggedIn) return
    api.get('/drawings', { params: { symbol: reqSymbol } })
      .then(res => {
        if (symbolRef.current !== reqSymbol) return
        const serverDrawings = sanitizeDrawings(res.data as Drawing[]).filter(
          d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'
        )
        const final = serverDrawings.length > 0 ? serverDrawings : stored
        setDrawings(final)
        saveToStorage(reqSymbol, final)
      })
      .catch(() => {})
  }, [symbol, isLoggedIn])

  useEffect(() => {
    const chart = chartRef.current
    const series = candleRef.current
    if (!chart || !series) return
    if (isInitialLoading) return

    const primitive = new DrawingsPrimitive()
    primitiveRef.current = primitive

    try {
      series.attachPrimitive(primitive)
    } catch (err) {
      console.debug('[useDrawings] Failed to attach primitive to series', err)
    }

    return () => {
      try {
        series.detachPrimitive(primitive)
      } catch (err) {
        console.debug('[useDrawings] Failed to detach primitive (chart disposed)', err)
      }
      primitiveRef.current = null
    }
  }, [chartVersion, isInitialLoading])

  const removeDrawing = useCallback((id: string) => {
    setDrawings(prev => {
      const next = prev.filter(d => d.id !== id)
      saveToStorage(symbolRef.current, next)
      return next
    })
    if (!isLocalId(id) && isLoggedIn) {
      api.delete(`/drawings/${id}`).catch(() => {})
    }
  }, [isLoggedIn])

  const updateDrawingState = useCallback((id: string, data: unknown) => {
    setDrawings(prev => {
      const next = prev.map(d => d.id === id ? { ...d, data: data as Drawing['data'] } : d)
      saveToStorage(symbolRef.current, next)
      return next
    })
  }, [])

  const commitDrawingToServer = useCallback((id: string, data: unknown) => {
    if (!isLoggedIn || isLocalId(id)) return
    api.put(`/drawings/${id}`, { data }).catch(() => {})
  }, [isLoggedIn])

  const shiftLogicalOffset = useCallback((added: number) => {
    if (added === 0) return
    setDrawings(prev => {
      const next = prev.map(d => {
        if (d.type === 'h-ray') {
          const data = d.data as HRayDrawing
          if (data.logical == null) return d
          const newLogical = data.logical + added
          const newTime = logicalToTime(candlesDataRef.current, newLogical) ?? data.time
          return { ...d, data: { ...data, logical: newLogical, time: newTime } }
        }
        if (d.type === 't-ray' || d.type === 'segment') {
          const data = d.data as TRayDrawing | SegmentDrawing
          const newFromLogical = data.fromLogical != null ? data.fromLogical + added : data.fromLogical
          const newToLogical = data.toLogical != null ? data.toLogical + added : data.toLogical
          const newFromTime = newFromLogical != null ? (logicalToTime(candlesDataRef.current, newFromLogical) ?? data.fromTime) : data.fromTime
          const newToTime = newToLogical != null ? (logicalToTime(candlesDataRef.current, newToLogical) ?? data.toTime) : data.toTime
          return { ...d, data: { ...data, fromLogical: newFromLogical, toLogical: newToLogical, fromTime: newFromTime, toTime: newToTime } }
        }
        return d
      })
      saveToStorage(symbolRef.current, next)
      return next
    })
  }, [candlesDataRef])

  useEffect(() => {
    const primitive = primitiveRef.current
    const chart = chartRef.current
    const series = candleRef.current
    const container = containerRef.current
    if (!primitive || !chart || !series || !container) return

    primitive.setDrawings(
      drawings,
      chart,
      series,
      container.clientWidth,
      container.clientHeight,
      pricePrecision,
      candlesDataRef.current,
      removeDrawing,
      updateDrawingState,
    )
    primitive.requestUpdate()
  }, [drawings, symbol, tf, pricePrecision, chartVersion, removeDrawing, updateDrawingState, isInitialLoading, candlesDataRef])

  const saveDrawing = useCallback(async (drawing: Drawing) => {
    if (!isLoggedIn) return
    const drawingSymbol = drawing.symbol
    try {
      const res = await api.post('/drawings', {
        symbol: drawingSymbol,
        type: drawing.type,
        data: drawing.data,
      })
      const saved = res.data as Drawing
      if (symbolRef.current === drawingSymbol) {
        setDrawings(prev => {
          const next = prev.map(d => d.id === drawing.id ? saved : d)
          saveToStorage(drawingSymbol, next)
          return next
        })
      } else {
        const stored = loadFromStorage(drawingSymbol)
        const updated = stored.map(d => d.id === drawing.id ? saved : d)
        saveToStorage(drawingSymbol, updated)
      }
    } catch {}
  }, [isLoggedIn])

  const clearAllDrawings = useCallback(() => {
    const ids = drawingsRef.current.map(d => d.id)
    setDrawings([])
    saveToStorage(symbolRef.current, [])
    if (isLoggedIn) {
      for (const id of ids) {
        if (!isLocalId(id)) api.delete(`/drawings/${id}`).catch(() => {})
      }
    }
  }, [isLoggedIn])

  const clearPending = useCallback(() => {
    setPendingPoint(null)
    const primitive = primitiveRef.current
    if (primitive) {
      primitive.setPreview(null)
      primitive.setPendingPoint(null)
    }
  }, [])

  const deactivateTool = useCallback(() => {
    deactivateGlobal()
    clearPending()
  }, [clearPending, deactivateGlobal])

  const placeDrawing = useCallback((price: number, time: number, logical?: number) => {
    const tool = activeToolRef.current
    if (!tool) return

    const curSymbol = symbolRef.current
    const pp = pendingPointRef.current

    if (tool === 'h-ray') {
      const data: HRayDrawing = { price, time, logical }
      const drawing: Drawing = {
        id: `${LOCAL_ID_PREFIX}${++localCounter}`,
        userId: '',
        symbol: curSymbol,
        type: 'h-ray',
        data,
      }
      setDrawings(prev => {
        const next = [...prev, drawing]
        saveToStorage(curSymbol, next)
        return next
      })
      saveDrawing(drawing)
      setActiveTool(null)
      clearPending()
      return
    }

    if (tool === 't-ray' || tool === 'segment') {
      if (!pp) {
        setPendingPoint({ price, time, logical })
        const primitive = primitiveRef.current
        const series = candleRef.current
        const chart = chartRef.current
        const container = containerRef.current
        if (primitive && series && chart && container) {
          const px = resolveExactX(chart, candlesDataRef.current, time as Time, logical)
          const py = series.priceToCoordinate(price)
          if (px !== null && py !== null) {
            primitive.setPendingPoint({ x: px, y: py })
          }
        }
        return
      }
      const data: TRayDrawing | SegmentDrawing = {
        fromPrice: pp.price,
        fromTime: pp.time,
        fromLogical: pp.logical,
        toPrice: price,
        toTime: time,
        toLogical: logical,
      }
      const drawing: Drawing = {
        id: `${LOCAL_ID_PREFIX}${++localCounter}`,
        userId: '',
        symbol: curSymbol,
        type: tool === 't-ray' ? 't-ray' : 'segment',
        data,
      }
      setDrawings(prev => {
        const next = [...prev, drawing]
        saveToStorage(curSymbol, next)
        return next
      })
      saveDrawing(drawing)
      setActiveTool(null)
      clearPending()
    }
  }, [saveDrawing, clearPending])

  useEffect(() => {
    deactivateGlobal()
    clearPending()
  }, [symbol, clearPending, deactivateGlobal])

  const pixelToPriceTime = useCallback((
    x: number,
    y: number,
  ): { price: number; time: number; logical?: number } | null => {
    const chart = chartRef.current
    const series = candleRef.current
    if (!chart || !series) return null

    const logical = chart.timeScale().coordinateToLogical(x) as number | null
    const price = series.coordinateToPrice(y) as number | null
    if (logical === null || price === null || !isFinite(logical) || !isFinite(price)) return null

    const time = logicalToTime(candlesDataRef.current, logical)
    if (time === null) return null

    return { price, time, logical }
  }, [candlesDataRef])

  const handleClick = useCallback((e: MouseEvent) => {
    const tool = activeToolRef.current
    if (!tool) return

    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const result = pixelToPriceTime(x, y)
    if (!result) return

    placeDrawing(result.price, result.time, result.logical)
  }, [placeDrawing, pixelToPriceTime])

  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (activeToolRef.current !== null) return

    const chart = chartRef.current
    const series = candleRef.current
    const container = containerRef.current
    const primitive = primitiveRef.current
    if (!chart || !series || !container || !primitive) return

    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const hit = primitive.hitTestDetailed(x, y)
    if (!hit) return

    const drawing = primitive.getDrawing(hit.id)
    if (!drawing) return

    dragStateRef.current = {
      drawingId: hit.id,
      pointIndex: hit.pointIndex,
      startMouseX: x,
      startMouseY: y,
      originalData: drawing.data as HRayDrawing | TRayDrawing | SegmentDrawing,
    }
    isDraggingRef.current = true
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const container = containerRef.current
    const chart = chartRef.current
    const series = candleRef.current
    const primitive = primitiveRef.current
    if (!container || !chart || !series || !primitive) return

    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (isDraggingRef.current && dragStateRef.current) {
      const result = pixelToPriceTime(x, y)
      if (!result) return

      const drawing = primitive.getDrawing(dragStateRef.current.drawingId)
      if (!drawing) return

      const newData = computeUpdatedDrawingData(
        drawing,
        dragStateRef.current.pointIndex,
        result.price,
        result.time,
        result.logical,
        dragStateRef.current,
        chart,
        series,
        candlesDataRef.current,
      )
      primitive.updateDrawingData(dragStateRef.current.drawingId, newData)
      return
    }

    if (activeToolRef.current !== null) {
      const pp = pendingPointRef.current
      if (pp) {
        const px1 = resolveExactX(chart, candlesDataRef.current, pp.time as Time, pp.logical)
        const py1 = series.priceToCoordinate(pp.price)
        if (px1 === null || py1 === null) return
        primitive.setPreview({ x1: px1, y1: py1, x2: x, y2: y })
      }
      return
    }

    const hit = primitive.hitTestDetailed(x, y)
    const hoveredId = hit?.id ?? null
    if (hoveredId !== hoveredIdRef.current) {
      hoveredIdRef.current = hoveredId
      primitive.setHoveredId(hoveredId)
    }
  }, [pixelToPriceTime, candlesDataRef])

  const handleMouseUp = useCallback((e: MouseEvent) => {
    void e
    if (!isDraggingRef.current || !dragStateRef.current) return

    const primitive = primitiveRef.current
    if (primitive) {
      const drawing = primitive.getDrawing(dragStateRef.current.drawingId)
      if (drawing) {
        const data = drawing.data as HRayDrawing | TRayDrawing | SegmentDrawing
        updateDrawingState(dragStateRef.current.drawingId, data)
        commitDrawingToServer(dragStateRef.current.drawingId, data)
      }
    }

    dragStateRef.current = null
    isDraggingRef.current = false
    if (primitive) primitive.setHoveredId(null)
    hoveredIdRef.current = null
  }, [updateDrawingState, commitDrawingToServer])

  useEffect(() => {
    const primitive = primitiveRef.current
    if (!primitive) return

    const pp = pendingPoint
    if (!pp) {
      primitive.setPendingPoint(null)
      primitive.setPreview(null)
      return
    }
    const chart = chartRef.current
    const series = candleRef.current
    if (!chart || !series) return

    const px = resolveExactX(chart, candlesDataRef.current, pp.time as Time, pp.logical)
    const py = series.priceToCoordinate(pp.price)
    if (px !== null && py !== null) {
      primitive.setPendingPoint({ x: px, y: py })
    } else {
      primitive.setPendingPoint(null)
    }
  }, [pendingPoint, drawings, symbol, tf, chartVersion, candlesDataRef])

  return {
    drawings,
    activeTool,
    setActiveTool,
    removeDrawing,
    clearAllDrawings,
    hasDrawings: drawings.some(d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'),
    deactivateTool,
    handleClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    pendingPoint,
    primitiveRef,
    isDraggingRef,
    shiftLogicalOffset,
    CLICK_THRESHOLD: 5,
  }
}
