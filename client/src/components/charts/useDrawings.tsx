import { useState, useRef, useCallback, useEffect } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { Drawing, DrawingType, HRayDrawing, TRayDrawing, SegmentDrawing } from '../../types'
import api from '../../services/api'
import { useAuthStore, useCoinListStore } from '../../store'

export type DrawingTool = 'h-ray' | 't-ray' | 'segment'

interface PendingPoint {
  price: number
  time: number
}

interface PreviewLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface RenderedDrawing {
  id: string
  type: DrawingType
  elements: React.ReactNode[]
}

const LOCAL_ID_PREFIX = 'local-'
let localCounter = 0

function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX)
}

function storageKey(symbol: string, tf: string): string {
  return `drawings:${symbol}:${tf}`
}

function loadFromStorage(symbol: string, tf: string): Drawing[] {
  try {
    const raw = localStorage.getItem(storageKey(symbol, tf))
    if (!raw) return []
    return JSON.parse(raw) as Drawing[]
  } catch {
    return []
  }
}

function saveToStorage(symbol: string, tf: string, drawings: Drawing[]) {
  try {
    localStorage.setItem(storageKey(symbol, tf), JSON.stringify(drawings))
  } catch {}
}

function renderDrawings(
  drawings: Drawing[],
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  cw: number,
  ch: number,
  pricePrecision: number,
  onRemove: (id: string) => void,
): RenderedDrawing[] {
  const rendered: RenderedDrawing[] = []

  for (const d of drawings) {
    if (d.type === 'h-ray') {
      const data = d.data as HRayDrawing
      const py = series.priceToCoordinate(data.price)
      const px = chart.timeScale().timeToCoordinate(data.time as Time)
      if (py === null || px === null) continue

      rendered.push({
        id: d.id,
        type: d.type,
        elements: [
          <g key={d.id} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(d.id); }} style={{ pointerEvents: 'auto' }}>
            <line x1={px} y1={py} x2={cw} y2={py} stroke="transparent" strokeWidth={12} pointerEvents="stroke" />
            <circle cx={px} cy={py} r={3} fill="#fff" stroke="#0e0e0e" strokeWidth={1} pointerEvents="none" />
            <line x1={px} y1={py} x2={cw} y2={py} stroke="#fff" strokeWidth={1} pointerEvents="none" />
            <text x={cw - 6} y={py - 6} textAnchor="end" fill="#fff" fontSize={10} fontFamily="'Inter', sans-serif" pointerEvents="none">
              {data.price.toFixed(pricePrecision)}
            </text>,
          </g>,
        ],
      })
    }

    if (d.type === 't-ray') {
      const data = d.data as TRayDrawing
      const y1 = series.priceToCoordinate(data.fromPrice)
      const x1 = chart.timeScale().timeToCoordinate(data.fromTime as Time)
      const y2 = series.priceToCoordinate(data.toPrice)
      const x2 = chart.timeScale().timeToCoordinate(data.toTime as Time)
      if (y1 === null || x1 === null || y2 === null || x2 === null) continue

      const dx = x2 - x1
      const dy = y2 - y1
      let endX = cw
      let endY = y2
      if (dx !== 0) {
        const t = (cw - x2) / dx
        endY = y2 + t * dy
      }

      if (endY < -50) {
        if (dy !== 0) {
          const t = (-50 - y2) / dy
          endX = x2 + t * dx
        }
        endY = -50
      } else if (endY > ch + 50) {
        if (dy !== 0) {
          const t = (ch + 50 - y2) / dy
          endX = x2 + t * dx
        }
        endY = ch + 50
      }

      rendered.push({
        id: d.id,
        type: d.type,
        elements: [
          <g key={d.id} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(d.id); }} style={{ pointerEvents: 'auto' }}>
            <line x1={x1} y1={y1} x2={endX} y2={endY} stroke="transparent" strokeWidth={12} pointerEvents="stroke" />
            <circle cx={x1} cy={y1} r={3} fill="#fff" stroke="#0e0e0e" strokeWidth={1} pointerEvents="none" />
            <circle cx={x2} cy={y2} r={3} fill="#fff" stroke="#0e0e0e" strokeWidth={1} pointerEvents="none" />
            <line x1={x1} y1={y1} x2={endX} y2={endY} stroke="#fff" strokeWidth={1} pointerEvents="none" />
          </g>,
        ],
      })
    }

    if (d.type === 'segment') {
      const data = d.data as SegmentDrawing
      const y1 = series.priceToCoordinate(data.fromPrice)
      const x1 = chart.timeScale().timeToCoordinate(data.fromTime as Time)
      const y2 = series.priceToCoordinate(data.toPrice)
      const x2 = chart.timeScale().timeToCoordinate(data.toTime as Time)
      if (y1 === null || x1 === null || y2 === null || x2 === null) continue

      rendered.push({
        id: d.id,
        type: d.type,
        elements: [
          <g key={d.id} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(d.id); }} style={{ pointerEvents: 'auto' }}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} pointerEvents="stroke" />
            <circle cx={x1} cy={y1} r={3} fill="#fff" stroke="#0e0e0e" strokeWidth={1} pointerEvents="none" />
            <circle cx={x2} cy={y2} r={3} fill="#fff" stroke="#0e0e0e" strokeWidth={1} pointerEvents="none" />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fff" strokeWidth={1} pointerEvents="none" />
          </g>,
        ],
      })
    }
  }

  return rendered
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
  const [renderedDrawings, setRenderedDrawings] = useState<RenderedDrawing[]>([])
  const isLoggedIn = useAuthStore(s => s.isLoggedIn)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)

  const drawingsRef = useRef(drawings)
  drawingsRef.current = drawings

  const activeToolRef = useRef<DrawingTool | null>(activeTool)
  activeToolRef.current = activeTool

  const pendingPointRef = useRef(pendingPoint)
  pendingPointRef.current = pendingPoint

  const initializedRef = useRef(false)

  // Load drawings: localStorage first (instant), then server (if auth)
  useEffect(() => {
    const stored = loadFromStorage(symbol, tf).filter(
      d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'
    )
    if (stored.length > 0) {
      setDrawings(stored)
    }

    if (!isLoggedIn) return
    api.get('/drawings', { params: { symbol, timeframe: tf } })
      .then(res => {
        const serverDrawings = (res.data as Drawing[]).filter(
          d => d.type === 'h-ray' || d.type === 't-ray' || d.type === 'segment'
        )
        setDrawings(serverDrawings.length > 0 ? serverDrawings : [])
        saveToStorage(symbol, tf, serverDrawings)
      })
      .catch(() => {})

    return () => {
      initializedRef.current = false
    }
  }, [symbol, tf, isLoggedIn])

  // Persist to localStorage on every change
  useEffect(() => {
    saveToStorage(symbol, tf, drawings)
  }, [drawings, symbol, tf])

  const saveDrawing = useCallback(async (drawing: Drawing) => {
    if (!isLoggedIn) return
    try {
      const res = await api.post('/drawings', {
        symbol: drawing.symbol,
        timeframe: drawing.timeframe,
        type: drawing.type,
        data: drawing.data,
      })
      const saved = res.data as Drawing
      setDrawings(prev => prev.map(d => d.id === drawing.id ? saved : d))
    } catch {}
  }, [isLoggedIn])

  const removeDrawing = useCallback((id: string) => {
    setDrawings(prev => prev.filter(d => d.id !== id))
    if (!isLocalId(id) && isLoggedIn) {
      api.delete(`/drawings/${id}`).catch(() => {})
    }
  }, [isLoggedIn])

  const clearAllDrawings = useCallback(() => {
    const ids = drawingsRef.current.map(d => d.id)
    setDrawings([])
    saveToStorage(symbol, tf, [])
    if (isLoggedIn) {
      for (const id of ids) {
        if (!isLocalId(id)) api.delete(`/drawings/${id}`).catch(() => {})
      }
    }
  }, [symbol, tf, isLoggedIn])

  const clearPending = useCallback(() => {
    setPendingPoint(null)
    setPreviewLine(null)
  }, [])

  const deactivateTool = useCallback(() => {
    setActiveTool(null)
    clearPending()
  }, [clearPending])

  const placeDrawing = useCallback((price: number, time: number) => {
    const tool = activeToolRef.current
    if (!tool) return

    const pp = pendingPointRef.current

    if (tool === 'h-ray') {
      const data: HRayDrawing = { price, time }
      const drawing: Drawing = {
        id: `${LOCAL_ID_PREFIX}${++localCounter}`,
        userId: '',
        symbol,
        timeframe: tf,
        type: 'h-ray',
        data,
      }
      setDrawings(prev => [...prev, drawing])
      saveDrawing(drawing)
      setActiveTool(null)
      clearPending()
      return
    }

    if (tool === 't-ray' || tool === 'segment') {
      if (!pp) {
        setPendingPoint({ price, time })
        return
      }
      const data: TRayDrawing | SegmentDrawing = {
        fromPrice: pp.price,
        fromTime: pp.time,
        toPrice: price,
        toTime: time,
      }
      const drawing: Drawing = {
        id: `${LOCAL_ID_PREFIX}${++localCounter}`,
        userId: '',
        symbol,
        timeframe: tf,
        type: tool === 't-ray' ? 't-ray' : 'segment',
        data,
      }
      setDrawings(prev => [...prev, drawing])
      saveDrawing(drawing)
      setActiveTool(null)
      clearPending()
    }
  }, [symbol, tf, saveDrawing, clearPending])

  useEffect(() => {
    setActiveTool(null)
    clearPending()
  }, [symbol, tf, clearPending])

  // Re-render SVG when drawings change
  useEffect(() => {
    const chart = chartRef.current
    const series = candleRef.current
    const container = containerRef.current
    if (!chart || !series || !container) return

    setRenderedDrawings(
      renderDrawings(drawings, chart, series, container.clientWidth, container.clientHeight, pricePrecision, removeDrawing)
    )
  }, [drawings, symbol, tf, pricePrecision, chartVersion, removeDrawing])

  // Subscribe to pan/zoom to re-render
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    let rafId: number | null = null
    const rerender = () => {
      if (rafId != null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const series = candleRef.current
        const container = containerRef.current
        if (!chart || !series || !container) return
        setRenderedDrawings(
          renderDrawings(drawingsRef.current, chart, series, container.clientWidth, container.clientHeight, pricePrecision, removeDrawing)
        )
      })
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(rerender)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rerender)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [symbol, tf, pricePrecision, chartVersion, removeDrawing])

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

    if (time === null) {
      const logical = chart.timeScale().coordinateToLogical(x) as number | null
      const visLogical = chart.timeScale().getVisibleLogicalRange()
      const visTime = chart.timeScale().getVisibleRange()
      if (logical !== null && visLogical && visTime) {
        const lFrom = visLogical.from as number
        const lTo = visLogical.to as number
        const tFrom = visTime.from as number
        const tTo = visTime.to as number
        if (lTo !== lFrom && isFinite(tFrom) && isFinite(tTo)) {
          time = tFrom + (logical - lFrom) * (tTo - tFrom) / (lTo - lFrom)
        }
      }
    }

    if (price === null || time === null || !isFinite(price) || !isFinite(time)) return

    placeDrawing(price, time)
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

    const px1 = chart.timeScale().timeToCoordinate(pp.time as Time)
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

    const px = chart.timeScale().timeToCoordinate(pp.time as Time)
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
    renderedDrawings,
    CLICK_THRESHOLD: 5,
  }
}
