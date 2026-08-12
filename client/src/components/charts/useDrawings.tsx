import { useState, useRef, useCallback, useEffect } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { Drawing, DrawingTool, HRayDrawing, TwoPointDrawing, UnifiedCandle, Alert } from '../../types'
import { isTwoPointTool } from '../../types'
import api from '../../services/api'
import { useAuthStore, useCoinListStore, useAlertStore } from '../../store'
import { onAlertRemoved } from '../../services/alert-drawing-sync'
import { useDrawingHotkeysStore, isInputFocused } from '../../store/drawingHotkeys'
import { DrawingsPrimitive, resolveExactX, logicalToTime, findBarByTime } from './drawings/primitive'

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
  originalData: HRayDrawing | TwoPointDrawing
}

const LOCAL_ID_PREFIX = 'local-'
let localCounter = 0

const SUPPORTED_DRAWING_TYPES = new Set<Drawing['type']>(['h-ray', 't-ray', 'segment', 'rect', 'fib', 'circle'])
const HISTORY_LIMIT = 50
const MAGNET_PX = 3

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
  if (d.type === 't-ray' || d.type === 'segment' || d.type === 'rect' || d.type === 'fib' || d.type === 'circle') {
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
): HRayDrawing | TwoPointDrawing {
  if (drawing.type === 'h-ray') {
    // Keep the style through a drag — an alert ray (dashed) must not turn
    // into a plain solid line when moved.
    const data = drawing.data as HRayDrawing
    return { price, time, logical, ...(data.style ? { style: data.style } : {}) }
  }

  if (isTwoPointTool(drawing.type as DrawingTool)) {
    const orig = dragState.originalData as TwoPointDrawing

    if (pointIndex === 0) {
      return { ...orig, fromPrice: price, fromTime: time, fromLogical: logical }
    }
    if (pointIndex === 1) {
      return { ...orig, toPrice: price, toTime: time, toLogical: logical }
    }

    if (pointIndex === null) {
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

  return drawing.data as HRayDrawing | TwoPointDrawing
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
  dataVersion: number = 0,
) {
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const undoStackRef = useRef<Drawing[][]>([])
  const redoStackRef = useRef<Drawing[][]>([])
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

  const pushHistory = useCallback(() => {
    undoStackRef.current.push(drawingsRef.current)
    if (undoStackRef.current.length > HISTORY_LIMIT) {
      undoStackRef.current.shift()
    }
    redoStackRef.current = []
  }, [])

  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop()
    if (!prev) return
    redoStackRef.current.push(drawingsRef.current)
    setDrawings(prev)
    saveToStorage(symbolRef.current, prev)
  }, [])

  const redo = useCallback(() => {
    const next = redoStackRef.current.pop()
    if (!next) return
    undoStackRef.current.push(drawingsRef.current)
    setDrawings(next)
    saveToStorage(symbolRef.current, next)
  }, [])

  const dragStateRef = useRef<DragState | null>(null)
  const isDraggingRef = useRef(false)
  const hoveredIdRef = useRef<string | null>(null)

  useEffect(() => {
    const reqSymbol = symbol
    const stored = sanitizeDrawings(loadFromStorage(reqSymbol)).filter(
      d => SUPPORTED_DRAWING_TYPES.has(d.type)
    )
    setDrawings(stored)
    undoStackRef.current = []
    redoStackRef.current = []
    const initialLocalIds = new Set(stored.map(d => d.id))

    if (!isLoggedIn) return
    api.get('/drawings', { params: { symbol: reqSymbol } })
      .then(res => {
        if (symbolRef.current !== reqSymbol) return
        // Race guard: the server snapshot is from BEFORE this fetch started.
        // If the user already drew something since then (a new local id), the
        // snapshot is stale and must never overwrite the session drawings.
        const current = drawingsRef.current
        const hasNewSessionDrawings = current.length > 0 && current.some(d => !initialLocalIds.has(d.id))
        if (hasNewSessionDrawings) {
          saveToStorage(reqSymbol, current)
          return
        }
        const serverDrawings = sanitizeDrawings(res.data as Drawing[]).filter(
          d => SUPPORTED_DRAWING_TYPES.has(d.type)
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
    if (!chart || !series || !chartVersion) return

    // NB: no isInitialLoading in deps — the primitive must stay attached across
    // TF switches / data reloads, otherwise drawings vanish while the new
    // timeframe's candles are loading (they only reappear after a re-attach).
    // Resyncs happen via the sync effect below on dataVersion change.
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
  }, [chartVersion])

  const removeDrawing = useCallback((id: string) => {
    // If the deleted line is an alert ray, remove the linked alert too — the
    // drawing and the Уведомления list stay in sync (dismissAlert deletes it
    // server-side, emits to other charts, and stops it firing).
    const victim = drawingsRef.current.find(d => d.id === id)
    if (victim?.type === 'h-ray' && (victim.data as HRayDrawing).alertId) {
      useAlertStore.getState().dismissAlert((victim.data as HRayDrawing).alertId!)
    }
    pushHistory()
    setDrawings(prev => {
      const next = prev.filter(d => d.id !== id)
      saveToStorage(symbolRef.current, next)
      return next
    })
    if (!isLocalId(id) && isLoggedIn) {
      api.delete(`/drawings/${id}`).catch(() => {})
    }
  }, [isLoggedIn, pushHistory])

  // When an alert is dismissed from the Уведомления list, remove its ray from
  // this chart (any chart showing it) — deletion is two-way.
  useEffect(() => {
    return onAlertRemoved((alertId) => {
      setDrawings(prev => {
        const removed = prev.filter(d => d.type === 'h-ray' && (d.data as HRayDrawing).alertId === alertId)
        if (removed.length === 0) return prev
        const next = prev.filter(d => !(d.type === 'h-ray' && (d.data as HRayDrawing).alertId === alertId))
        saveToStorage(symbolRef.current, next)
        for (const d of removed) {
          if (!isLocalId(d.id) && isLoggedIn) {
            api.delete(`/drawings/${d.id}`).catch(() => {})
          }
        }
        return next
      })
    })
  }, [isLoggedIn])

  const updateDrawingState = useCallback((id: string, data: unknown) => {
    pushHistory()
    setDrawings(prev => {
      const next = prev.map(d => d.id === id ? { ...d, data: data as Drawing['data'] } : d)
      saveToStorage(symbolRef.current, next)
      return next
    })
  }, [pushHistory])

  const commitDrawingToServer = useCallback((id: string, data: unknown) => {
    if (!isLoggedIn || isLocalId(id)) return
    api.put(`/drawings/${id}`, { data }).catch(() => {})
  }, [isLoggedIn])

  const shiftLogicalOffset = useCallback((added: number) => {
    if (added === 0) return
    const primitive = primitiveRef.current
    if (primitive) {
      primitive.shiftLogical(added, candlesDataRef.current)
    }
    setDrawings(prev => {
      const next = prev.map(d => {
        if (d.type === 'h-ray') {
          const data = d.data as HRayDrawing
          if (data.logical == null) return d
          const newLogical = data.logical + added
          const newTime = logicalToTime(candlesDataRef.current, newLogical) ?? data.time
          return { ...d, data: { ...data, logical: newLogical, time: newTime } }
        }
        if (d.type === 't-ray' || d.type === 'segment' || d.type === 'rect' || d.type === 'fib' || d.type === 'circle') {
          const data = d.data as TwoPointDrawing
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

    const candleData = candlesDataRef.current
    let logicalsChanged = false

    const syncedDrawings = drawings.map(d => {
      if (d.type === 'h-ray') {
        const data = d.data as HRayDrawing
        const barIdx = findBarByTime(candleData, data.time)
        if (barIdx !== null && barIdx !== data.logical) {
          logicalsChanged = true
          return { ...d, data: { ...data, logical: barIdx } }
        }
        return d
      }
      if (d.type === 't-ray' || d.type === 'segment' || d.type === 'rect' || d.type === 'fib' || d.type === 'circle') {
        const data = d.data as TwoPointDrawing
        const fromIdx = findBarByTime(candleData, data.fromTime)
        const toIdx = findBarByTime(candleData, data.toTime)
        let changed = false
        let newFromLogical = data.fromLogical
        let newToLogical = data.toLogical
        if (fromIdx !== null && fromIdx !== data.fromLogical) { newFromLogical = fromIdx; changed = true }
        if (toIdx !== null && toIdx !== data.toLogical) { newToLogical = toIdx; changed = true }
        if (changed) {
          logicalsChanged = true
          return { ...d, data: { ...data, fromLogical: newFromLogical, toLogical: newToLogical } }
        }
        return d
      }
      return d
    })

    primitive.setDrawings(
      syncedDrawings,
      chart,
      series,
      container.clientWidth,
      container.clientHeight,
      pricePrecision,
      candleData,
      removeDrawing,
      updateDrawingState,
    )
    primitive.requestUpdate()

    if (logicalsChanged) {
      const toPersist = syncedDrawings
      setDrawings(toPersist)
      saveToStorage(symbolRef.current, toPersist)
    }
  }, [drawings, symbol, tf, pricePrecision, chartVersion, removeDrawing, updateDrawingState, isInitialLoading, dataVersion, candlesDataRef])

  const saveDrawing = useCallback(async (drawing: Drawing): Promise<Drawing | null> => {
    if (!isLoggedIn) return null
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
      return saved
    } catch {
      return null
    }
  }, [isLoggedIn])

  const clearAllDrawings = useCallback(() => {
    // Dismiss every linked alert so no alert keeps firing without its ray.
    for (const d of drawingsRef.current) {
      if (d.type === 'h-ray' && (d.data as HRayDrawing).alertId) {
        useAlertStore.getState().dismissAlert((d.data as HRayDrawing).alertId!)
      }
    }
    pushHistory()
    const ids = drawingsRef.current.map(d => d.id)
    setDrawings([])
    saveToStorage(symbolRef.current, [])
    if (isLoggedIn) {
      for (const id of ids) {
        if (!isLocalId(id)) api.delete(`/drawings/${id}`).catch(() => {})
      }
    }
  }, [isLoggedIn, pushHistory])

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

    if (tool === 'alert') {
      // Price-alert tool: place a dashed h-ray at the clicked price AND create
      // a price alert for that level. The line is an ordinary h-ray drawing
      // (persisted like any other), rendered amber/dashed by primitive.ts;
      // the alert is created server-side and fires through the alert engine.
      // The ray is linked to the alert by alertId so deleting either one
      // removes the other (see removeDrawing / onAlertRemoved).
      pushHistory()
      const data: HRayDrawing = { price, time, logical, style: 'dashed' }
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

      // Direction is chosen so the alert does NOT fire instantly: clicked
      // above the current price → 'above' (price must rise to the level),
      // below → 'below' (price must fall).
      const coin = useCoinListStore.getState().coinMap.get(curSymbol)
      const currentPrice = coin?.price
      const direction = currentPrice !== undefined && price < currentPrice ? 'below' : 'above'

      // Persist the drawing first so we know its server id, then create the
      // alert and link them. Both steps are required for two-way deletion.
      saveDrawing(drawing).then((saved) => {
        if (!saved) return
        if (!isLoggedIn) return
        api.post('/alerts', {
          type: 'price',
          symbol: curSymbol,
          exchange: coin?.exchange ?? null,
          condition: { price, direction },
        })
          .then((res) => {
            const alert = res.data as Alert
            // Show the created alert in the Уведомления list right away.
            useAlertStore.getState().addCreated(alert)
            // Link the ray to the alert: store alertId on the drawing and
            // persist it (server + localStorage).
            const linkedData: HRayDrawing = { ...data, alertId: alert.id }
            setDrawings(prev => {
              const next = prev.map(d => d.id === saved.id ? { ...d, data: linkedData } : d)
              saveToStorage(curSymbol, next)
              return next
            })
            api.put(`/drawings/${saved.id}`, { data: linkedData }).catch(() => {})
          })
          .catch(() => { /* alert engine covers failures silently */ })
      })
      setActiveTool(null)
      clearPending()
      return
    }

    if (tool === 'h-ray') {
      pushHistory()
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

    if (isTwoPointTool(tool)) {
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
      pushHistory()
      const data: TwoPointDrawing = {
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
        type: tool === 't-ray' ? 't-ray' : tool === 'rect' ? 'rect' : tool === 'fib' ? 'fib' : tool === 'circle' ? 'circle' : 'segment',
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
  }, [saveDrawing, clearPending, pushHistory])

  useEffect(() => {
    deactivateGlobal()
    clearPending()
  }, [symbol, clearPending, deactivateGlobal])

  // Clear any in-progress pending point when the tool changes — otherwise a
  // half-placed ray from a previous tool session snaps its second point to the
  // wrong bar (stale pendingPointRef from the old tool).
  useEffect(() => {
    clearPending()
  }, [activeTool, clearPending])

  // Same for TF switch: the pending point's `time` belongs to the old TF's
  // candles; keeping it makes the second click land on a shifted bar.
  useEffect(() => {
    clearPending()
  }, [tf, clearPending])

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

  // Magnet: snap a placement point to the nearest candle's high/low when the
  // click lands within MAGNET_PX of it (in screen pixels). Like scalpboard.
  const applyMagnet = useCallback((y: number, price: number, logical?: number): number => {
    const series = candleRef.current
    const candleData = candlesDataRef.current
    if (!series || !candleData || candleData.length === 0) return price
    if (logical == null || !Number.isFinite(logical)) return price
    const idx = Math.floor(logical)
    if (idx < 0 || idx >= candleData.length) return price
    const bar = candleData[idx]
    const yHigh = series.priceToCoordinate(bar.high)
    const yLow = series.priceToCoordinate(bar.low)
    if (yHigh !== null && Math.abs(y - yHigh) <= MAGNET_PX) return bar.high
    if (yLow !== null && Math.abs(y - yLow) <= MAGNET_PX) return bar.low
    return price
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

    const snappedPrice = applyMagnet(y, result.price, result.logical)
    placeDrawing(snappedPrice, result.time, result.logical)
  }, [placeDrawing, pixelToPriceTime, applyMagnet])

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
      originalData: drawing.data as HRayDrawing | TwoPointDrawing,
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
        const tool = activeToolRef.current
        const previewType: 'line' | 'rect' | 'fib' | 'circle' =
          tool === 'rect' ? 'rect' : tool === 'fib' ? 'fib' : tool === 'circle' ? 'circle' : 'line'
        primitive.setPreview({ type: previewType, x1: px1, y1: py1, x2: x, y2: y })
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
        const data = drawing.data as HRayDrawing | TwoPointDrawing
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

  // Undo/redo history navigation: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputFocused()) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  return {
    drawings,
    activeTool,
    setActiveTool,
    removeDrawing,
    clearAllDrawings,
    undo,
    redo,
    hasDrawings: drawings.some(d => SUPPORTED_DRAWING_TYPES.has(d.type)),
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
