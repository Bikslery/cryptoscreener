import { useState, useRef, useCallback, useEffect } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { Drawing, DrawingTool, HRayDrawing, TRayDrawing, SegmentDrawing, UnifiedCandle } from '../../types'
import api from '../../services/api'
import { useAuthStore, useCoinListStore } from '../../store'
import { useDrawingHotkeysStore } from '../../store/drawingHotkeys'
import { DrawingsPrimitive, timeToPixel } from './drawings/primitive'

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

// DIAG-fd0c: validate drawing data shape before rendering. Legacy localStorage
// entries (pre-drawings-rewrite) may have `time: null`, `time: NaN`, or
// `logical` coords stored as the only time source. Passing those to LWC's
// timeToCoordinate throws an uncaught error that crashes the whole ChartGrid.
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

// DIAG-tf-anchor: normalise LWC's `Time` to UNIX-seconds. On 1d/1w/1M
// timeframes LWC returns a BusinessDay `{year, month, day}` object instead
// of a number. The `as number` cast does NOT convert it at runtime, so
// we go through Date.UTC (crypto charts are UTC-anchored).
function toUnixTime(t: unknown): number | null {
  if (t == null) return null
  if (typeof t === 'number') return Number.isFinite(t) ? t : null
  if (typeof t === 'string') {
    const parsed = Date.parse(t)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
  }
  if (typeof t === 'object') {
    const o = t as { year?: unknown; month?: unknown; day?: unknown }
    if (typeof o.year === 'number' && typeof o.month === 'number' && typeof o.day === 'number') {
      return Math.floor(Date.UTC(o.year, o.month - 1, o.day) / 1000)
    }
  }
  return null
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
  const [previewLine, setPreviewLine] = useState<PreviewLine | null>(null)
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

  // Load drawings: localStorage first (instant), then server (if auth)
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

  // Create & attach primitive to chart
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    // Gate on data readiness: attaching a primitive to a chart with no
    // series data produces stale-pixel render paths and creates a race
    // between setData() and the first paint(). Wait for isInitialLoading
    // to flip false so the chart has data and a valid visible range.
    if (isInitialLoading) return

    const primitive = new DrawingsPrimitive()
    primitiveRef.current = primitive

    // DIAG-fd0c: wrap panes() in try-catch — chart.panes() may throw or
    // return an empty array during chart init/destroy. Without this guard,
    // the whole ChartGrid unmounts and the user sees "Chart error".
    let pane: ReturnType<typeof chart.panes>[number] | undefined
    try {
      pane = chart.panes()[0]
    } catch (err) {
      console.debug('[useDrawings] Failed to read chart.panes()', err)
      pane = undefined
    }
    if (pane) {
      try {
        pane.attachPrimitive(primitive)
      } catch (err) {
        console.debug('[useDrawings] Failed to attach primitive', err)
      }
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
      candlesDataRef.current,
      removeDrawing,
    )
    primitive.requestUpdate()
  }, [drawings, symbol, tf, pricePrecision, chartVersion, removeDrawing, isInitialLoading, candlesDataRef])

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
      // Click landed outside the visible bar range. Use the loaded
      // candle data to find the closest bar's time — this is the same
      // authoritative lookup the renderer uses, so the stored time
      // will always re-resolve to a real bar on future TF switches.
      const logicalFromCoord = chart.timeScale().coordinateToLogical(x) as number | null
      if (logicalFromCoord !== null) {
        logical = logicalFromCoord
        const candleData = candlesDataRef.current
        if (candleData && candleData.length > 0) {
          const idx = Math.max(0, Math.min(candleData.length - 1, Math.floor(logicalFromCoord)))
          time = candleData[idx]?.time ?? null
        }
      }
    } else {
      // DIAG-c2a4: normalise LWC's Time (may be BusinessDay on 1d+ TFs)
      // to UNIX-seconds so the drawing survives future TF switches.
      time = toUnixTime(time)
      const logicalFromTime = chart.timeScale().coordinateToLogical(x) as number | null
      if (logicalFromTime !== null) logical = logicalFromTime
    }

    if (price === null || time === null || !isFinite(price) || !isFinite(time)) return

    placeDrawing(price, time, logical)
  }, [placeDrawing, candlesDataRef])

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

    const px1 = timeToPixel(chart, candlesDataRef.current, pp.time as Time)
    const py1 = series.priceToCoordinate(pp.price)
    if (px1 === null || py1 === null) return

    const rect = container.getBoundingClientRect()
    const x2 = e.clientX - rect.left
    const y2 = e.clientY - rect.top

    setPreviewLine({ x1: px1, y1: py1, x2, y2 })
  }, [candlesDataRef])

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

    const px = timeToPixel(chart, candlesDataRef.current, pp.time as Time)
    const py = series.priceToCoordinate(pp.price)
    if (px !== null && py !== null) {
      pendingPointPixel.current = { x: px, y: py }
    } else {
      pendingPointPixel.current = null
    }
  }, [pendingPoint, drawings, symbol, tf, chartVersion, candlesDataRef])

  // DIAG-tf-anchor: keep the binary-search helper reachable for callers
  // that want to verify stored drawing times are still in-range. Exported
  // via the hook return so tests and other modules can use it.
  // (No-op here — the import is re-exported for test access if needed.)

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
