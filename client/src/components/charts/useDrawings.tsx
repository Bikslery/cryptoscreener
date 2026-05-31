import { useState, useRef, useCallback, useEffect } from 'react'
import type { IChartApi, ISeriesApi, Logical, Time } from 'lightweight-charts'
import type { Drawing, HRayDrawing, TRayDrawing, SegmentDrawing } from '../../types'
import api from '../../services/api'
import { useAuthStore, useCoinListStore } from '../../store'
import { DrawingsPrimitive } from './drawings/primitive'

export type DrawingTool = 'h-ray' | 't-ray' | 'segment'

interface PendingPoint {
  price: number
  time: number
  logical?: number
}

interface PreviewLine {
  x1: number
  y1: number
  x2: number
  y2: number
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

export function useDrawings(
  symbol: string,
  tf: string,
  chartRef: React.RefObject<IChartApi | null>,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  chartVersion: number,
) {
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [activeTool, setActiveTool] = useState<DrawingTool | null>(null)
  const [pendingPoint, setPendingPoint] = useState<PendingPoint | null>(null)
  const [previewLine, setPreviewLine] = useState<PreviewLine | null>(null)
  const isLoggedIn = useAuthStore(s => s.isLoggedIn)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)

  const drawingsRef = useRef(drawings)
  drawingsRef.current = drawings

  const activeToolRef = useRef<DrawingTool | null>(activeTool)
  activeToolRef.current = activeTool

  const pendingPointRef = useRef(pendingPoint)
  pendingPointRef.current = pendingPoint

  const primitiveRef = useRef<DrawingsPrimitive | null>(null)

  const symbolRef = useRef(symbol)
  symbolRef.current = symbol

  // Load drawings: localStorage first (instant), then server (if auth)
  useEffect(() => {
    const reqSymbol = symbol
    const stored = loadFromStorage(reqSymbol).filter(
      d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'
    )
    setDrawings(stored)

    if (!isLoggedIn) return
    api.get('/drawings', { params: { symbol: reqSymbol } })
      .then(res => {
        if (symbolRef.current !== reqSymbol) return
        const serverDrawings = (res.data as Drawing[]).filter(
          d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'
        )
        const final = serverDrawings.length > 0 ? serverDrawings : stored
        setDrawings(final)
        saveToStorage(reqSymbol, final)
      })
      .catch(() => {})
  }, [symbol, isLoggedIn])

  // Create & attach primitive to chart
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const primitive = new DrawingsPrimitive()
    primitiveRef.current = primitive

    const pane = chart.panes()[0]
    if (pane) {
      pane.attachPrimitive(primitive)
    }

    return () => {
      if (pane && primitive) {
        try {
          pane.detachPrimitive(primitive)
        } catch (err) {
          // Chart may already be disposed, ignore error
          console.debug('[useDrawings] Failed to detach primitive (chart disposed)', err)
        }
      }
      primitiveRef.current = null
    }
  }, [chartVersion])

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

  // Sync drawings to primitive
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
      removeDrawing,
    )
    primitive.requestUpdate()
  }, [drawings, symbol, tf, pricePrecision, chartVersion, removeDrawing])

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
    setPreviewLine(null)
  }, [])

  const deactivateTool = useCallback(() => {
    setActiveTool(null)
    clearPending()
  }, [clearPending])

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
    setActiveTool(null)
    clearPending()
  }, [symbol, clearPending])

  // Click handler for placing drawings
  const handleClick = useCallback((e: MouseEvent) => {
    const tool = activeToolRef.current
    if (!tool) return

    const chart = chartRef.current
    const series = candleRef.current
    const container = containerRef.current
    if (!chart || !series || !container) return

    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const price = series.coordinateToPrice(y) as number | null
    let time = chart.timeScale().coordinateToTime(x) as number | null
    let logical: number | undefined

    if (time === null) {
      const logicalFromCoord = chart.timeScale().coordinateToLogical(x) as number | null
      const visLogical = chart.timeScale().getVisibleLogicalRange()
      const visTime = chart.timeScale().getVisibleRange()
      if (logicalFromCoord !== null && visLogical && visTime) {
        const lFrom = visLogical.from as number
        const lTo = visLogical.to as number
        const tFrom = visTime.from as number
        const tTo = visTime.to as number
        if (lTo !== lFrom && isFinite(tFrom) && isFinite(tTo)) {
          time = tFrom + (logicalFromCoord - lFrom) * (tTo - tFrom) / (lTo - lFrom)
          logical = logicalFromCoord
        }
      }
    } else {
      const logicalFromTime = chart.timeScale().coordinateToLogical(x) as number | null
      if (logicalFromTime !== null) logical = logicalFromTime
    }

    if (price === null || time === null || !isFinite(price) || !isFinite(time)) return

    placeDrawing(price, time, logical)
  }, [placeDrawing])

  // Mouse move for preview line
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const pp = pendingPointRef.current
    if (!pp) {
      setPreviewLine(null)
      return
    }
    const chart = chartRef.current
    const series = candleRef.current
    const container = containerRef.current
    if (!chart || !series || !container) return

    const px1 = timeToPixel(chart, pp.time as Time, pp.logical)
    const py1 = series.priceToCoordinate(pp.price)
    if (px1 === null || py1 === null) return

    const rect = container.getBoundingClientRect()
    const x2 = e.clientX - rect.left
    const y2 = e.clientY - rect.top

    setPreviewLine({ x1: px1, y1: py1, x2, y2 })
  }, [])

  // Pending point pixel position
  const pendingPointPixel = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const pp = pendingPoint
    if (!pp) {
      pendingPointPixel.current = null
      return
    }
    const chart = chartRef.current
    const series = candleRef.current
    if (!chart || !series) return

    const px = timeToPixel(chart, pp.time as Time, pp.logical)
    const py = series.priceToCoordinate(pp.price)
    if (px !== null && py !== null) {
      pendingPointPixel.current = { x: px, y: py }
    } else {
      pendingPointPixel.current = null
    }
  }, [pendingPoint, drawings, symbol, tf, chartVersion])

  return {
    drawings,
    activeTool,
    setActiveTool,
    removeDrawing,
    clearAllDrawings,
    hasDrawings: drawings.some(d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'),
    deactivateTool,
    handleClick,
    handleMouseMove,
    pendingPoint,
    pendingPointPixel: pendingPointPixel.current,
    previewLine,
    primitiveRef,
    CLICK_THRESHOLD: 5,
  }
}
