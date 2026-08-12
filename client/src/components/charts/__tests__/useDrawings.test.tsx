import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef, useLayoutEffect, type RefObject } from 'react'
import type { IChartApi, ISeriesApi, ITimeScaleApi, Time } from 'lightweight-charts'
import type { UnifiedCandle } from '../../../types'
import { useDrawings } from '../useDrawings'
import { DrawingsPrimitive } from '../drawings/primitive'
import { useDrawingHotkeysStore } from '../../../store/drawingHotkeys'

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn(() => Promise.resolve({ data: {} })) }))

vi.mock('../../../services/api', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: [] })),
    post: mockPost,
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}))

vi.mock('../../../store', () => {
  const coinMap = new Map<string, { pricePrecision: number; price: number; exchange: string }>([
    ['BTCUSDT', { pricePrecision: 2, price: 110, exchange: 'binance-futures' }],
  ])
  const coinListStore = <T,>(selector: (s: { coinMap: typeof coinMap }) => T) =>
    selector({ coinMap })
  return {
    useAuthStore: <T,>(selector: (s: { isLoggedIn: boolean }) => T) =>
      selector({ isLoggedIn: true }),
    // The hook also reads useCoinListStore.getState().coinMap (alert tool).
    useCoinListStore: Object.assign(coinListStore, { getState: () => ({ coinMap }) }),
    useAlertStore: Object.assign(
      (selector: (s: { alerts: unknown[] }) => unknown) => selector({ alerts: [] }),
      { getState: () => ({ alerts: [], addCreated: vi.fn() }) },
    ),
  }
})

interface MockRefs {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  container: HTMLDivElement
  attachPrimitive: ReturnType<typeof vi.fn>
  detachPrimitive: ReturnType<typeof vi.fn>
}

function makeMockRefs(): MockRefs {
  const attachPrimitive = vi.fn()
  const detachPrimitive = vi.fn()
  const timeScale: Partial<ITimeScaleApi<Time>> = {
    timeToCoordinate: vi.fn(() => null),
    getVisibleLogicalRange: vi.fn(() => null),
    getVisibleRange: vi.fn(() => null),
    logicalToCoordinate: vi.fn((l: number) => l * 6 as never),
    coordinateToTime: vi.fn(() => null),
    coordinateToLogical: vi.fn((x: number) => x / 6 as never),
    options: vi.fn(() => ({ barSpacing: 6 }) as any),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  }
  const series = {
    priceToCoordinate: vi.fn(() => 200),
    coordinateToPrice: vi.fn(() => 100),
    attachPrimitive,
    detachPrimitive,
  } as unknown as ISeriesApi<'Candlestick'>
  const chart = {
    panes: vi.fn(() => []),
    timeScale: vi.fn(() => timeScale as ITimeScaleApi<Time>),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  } as unknown as IChartApi
  const container = {
    clientWidth: 800,
    clientHeight: 400,
    getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400, x: 0, y: 0, toJSON: () => '' })),
  } as unknown as HTMLDivElement
  return { chart, series, container, attachPrimitive, detachPrimitive }
}

interface HookProps {
  symbol: string
  tf: string
  chartVersion: number
  isInitialLoading: boolean
  refs: MockRefs
  candlesData?: UnifiedCandle[]
}

function useDrawingsHarness(props: HookProps) {
  const chartRef = useRef<IChartApi | null>(null) as RefObject<IChartApi | null>
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null) as RefObject<ISeriesApi<'Candlestick'> | null>
  const containerRef = useRef<HTMLDivElement | null>(null) as RefObject<HTMLDivElement | null>
  const candlesDataRef = useRef<UnifiedCandle[]>(props.candlesData ?? []) as RefObject<UnifiedCandle[]>
  useLayoutEffect(() => {
    candlesDataRef.current = props.candlesData ?? []
  })
  useLayoutEffect(() => {
    chartRef.current = props.refs.chart
    candleRef.current = props.refs.series
    containerRef.current = props.refs.container
  })
  return useDrawings(
    props.symbol,
    props.tf,
    chartRef,
    candleRef,
    containerRef,
    candlesDataRef,
    props.chartVersion,
    props.isInitialLoading,
  )
}

describe('useDrawings — primitive lifecycle on TF change', () => {
  let refs: MockRefs

  beforeEach(() => {
    refs = makeMockRefs()
    localStorage.clear()
  })

  it('attaches the primitive as soon as the chart exists, even while data is still loading', () => {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 1,
        isInitialLoading: true,
        refs,
      },
    })
    // Attach must NOT depend on isInitialLoading — otherwise drawings vanish
    // (and only reappear after a re-attach) during a TF switch reload.
    expect(refs.attachPrimitive).toHaveBeenCalledTimes(1)
    expect(result.current.primitiveRef.current).not.toBeNull()
  })

  it('does not attach when the chart has not been created yet', () => {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 0,
        isInitialLoading: true,
        refs,
      },
    })
    expect(result.current.primitiveRef.current).toBeNull()
  })

  it('re-attaches when the chart itself is recreated (chartVersion bump)', () => {
    const { result, rerender } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 1,
        isInitialLoading: true,
        refs,
      },
    })
    const firstPrimitive = result.current.primitiveRef.current
    expect(firstPrimitive).not.toBeNull()

    const refs2 = makeMockRefs()
    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 2,
        isInitialLoading: true,
        refs: refs2,
      })
    })
    const newPrimitive = result.current.primitiveRef.current
    expect(newPrimitive).not.toBeNull()
    expect(newPrimitive).not.toBe(firstPrimitive)
  })

  it('keeps the same primitive across a TF switch and re-syncs drawings to it', () => {
    const drawing = {
      id: 'local-1',
      userId: '',
      symbol: 'BTCUSDT',
      type: 'h-ray',
      data: { price: 100, time: 1700000000, logical: 0 },
    }
    localStorage.setItem('drawings:BTCUSDT', JSON.stringify([drawing]))

    const setDrawingsSpy = vi.spyOn(DrawingsPrimitive.prototype, 'setDrawings')

    const { result, rerender } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 1,
        isInitialLoading: false,
        refs,
      },
    })
    const firstPrimitive = result.current.primitiveRef.current
    expect(firstPrimitive).not.toBeNull()
    const callsAfterFirstLoad = setDrawingsSpy.mock.calls.length

    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '15m',
        chartVersion: 1,
        isInitialLoading: true,
        refs,
      })
    })
    // TF switch must NOT detach/re-attach the primitive — that's the bug where
    // drawings disappear while the new timeframe's candles load.
    expect(refs.attachPrimitive).toHaveBeenCalledTimes(1)
    expect(result.current.primitiveRef.current).toBe(firstPrimitive)

    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '15m',
        chartVersion: 1,
        isInitialLoading: false,
        refs,
      })
    })
    expect(result.current.primitiveRef.current).toBe(firstPrimitive)

    // Drawings are still re-synced to the primitive after the switch.
    expect(setDrawingsSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstLoad)
    const lastCall = setDrawingsSpy.mock.calls[setDrawingsSpy.mock.calls.length - 1]
    const drawingsArg = lastCall[0] as Array<{ id: string }>
    expect(drawingsArg.map(d => d.id)).toContain('local-1')
  })

  it('exposes isDraggingRef for scroll control', () => {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 1,
        isInitialLoading: false,
        refs,
      },
    })
    expect(result.current.isDraggingRef).toBeDefined()
    expect(result.current.isDraggingRef.current).toBe(false)
  })

  it('exposes handleMouseDown and handleMouseUp for drag', () => {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 1,
        isInitialLoading: false,
        refs,
      },
    })
    expect(typeof result.current.handleMouseDown).toBe('function')
    expect(typeof result.current.handleMouseUp).toBe('function')
  })
})

describe('useDrawings — pixelToPriceTime via handleClick', () => {
  beforeEach(() => {
    localStorage.clear()
    useDrawingHotkeysStore.getState().deactivate()
  })

  it('places a drawing at the extrapolated logical when clicking outside the pane', () => {
    // Bug #1: clicking on the price axis (x > pane width) used to produce
    // a clamped time + extrapolated logical mismatch. Now logical is primary
    // and time is derived — the drawing lands where the user clicked.
    const candles: UnifiedCandle[] = Array.from({ length: 10 }, (_, i) => ({
      symbol: 'BTCUSDT', exchange: 'binance-spot', timeframe: '5m',
      time: 1700000000 + i * 300, open: 100, high: 100, low: 100, close: 100, volume: 0,
    }))

    useDrawingHotkeysStore.getState().activateTool('h-ray')
    const refs = makeMockRefs()
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT', tf: '5m', chartVersion: 1, isInitialLoading: false, refs, candlesData: candles,
      },
    })

    // The hook's useEffect deactivates the tool on mount — re-activate after render.
    act(() => {
      useDrawingHotkeysStore.getState().activateTool('h-ray')
    })

    // Click at x=900 (past pane width=800, in the price axis area).
    // coordinateToLogical(900) = 900/6 = 150 (extrapolated, past 10 bars).
    // coordinateToPrice(y) = 100 (mock).
    // logicalToTime(150, candles) = 1700000000 + 150*300 = 1700000000 + 45000.
    const fakeEvent = { clientX: 900, clientY: 250 } as MouseEvent
    act(() => {
      result.current.handleClick(fakeEvent)
    })

    expect(result.current.drawings.length).toBe(1)
    const d = result.current.drawings[0]
    expect(d.type).toBe('h-ray')
    const data = d.data as { price: number; time: number; logical?: number }
    expect(data.price).toBe(100)
    // After click: logical=150 (extrapolated), time=1700000000+150*300.
    // Sync effect recomputes logical from time via findBarByTime:
    // 1700000045000 > last bar (170000002700) → findBarByTime returns 9.
    expect(data.logical).toBe(9)
    expect(data.time).toBe(1700000000 + 150 * 300)
  })
})

describe('useDrawings — undo/redo history', () => {
  let refs: MockRefs
  const candles: UnifiedCandle[] = Array.from({ length: 10 }, (_, i) => ({
    symbol: 'BTCUSDT', exchange: 'binance-spot', timeframe: '5m',
    time: 1700000000 + i * 300, open: 100, high: 100, low: 100, close: 100, volume: 0,
  }))

  beforeEach(() => {
    refs = makeMockRefs()
    localStorage.clear()
    useDrawingHotkeysStore.getState().deactivate()
  })

  function renderPlaced(activate: (s: typeof useDrawingHotkeysStore) => void) {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT', tf: '5m', chartVersion: 1, isInitialLoading: false, refs, candlesData: candles,
      },
    })
    act(() => {
      activate(useDrawingHotkeysStore)
    })
    return result
  }

  it('undo restores drawings removed by removeDrawing, redo re-applies', () => {
    const result = renderPlaced(s => s.getState().activateTool('h-ray'))
    const click = () => {
      act(() => { useDrawingHotkeysStore.getState().activateTool('h-ray') })
      act(() => { result.current.handleClick({ clientX: 60, clientY: 120 } as MouseEvent) })
    }
    click()
    click()
    expect(result.current.drawings.length).toBe(2)

    act(() => {
      result.current.removeDrawing(result.current.drawings[0].id)
    })
    expect(result.current.drawings.length).toBe(1)

    act(() => {
      result.current.undo()
    })
    expect(result.current.drawings.length).toBe(2)

    act(() => {
      result.current.redo()
    })
    expect(result.current.drawings.length).toBe(1)
  })

  it('undo of clearAllDrawings restores all drawings', () => {
    const result = renderPlaced(s => s.getState().activateTool('h-ray'))
    const click = () => {
      act(() => { useDrawingHotkeysStore.getState().activateTool('h-ray') })
      act(() => { result.current.handleClick({ clientX: 60, clientY: 120 } as MouseEvent) })
    }
    click()
    click()
    expect(result.current.drawings.length).toBe(2)

    act(() => {
      result.current.clearAllDrawings()
    })
    expect(result.current.drawings.length).toBe(0)

    act(() => {
      result.current.undo()
    })
    expect(result.current.drawings.length).toBe(2)
  })
})

describe('useDrawings — magnet and new tools', () => {
  let refs: MockRefs
  const candles: UnifiedCandle[] = Array.from({ length: 10 }, (_, i) => ({
    symbol: 'BTCUSDT', exchange: 'binance-spot', timeframe: '5m',
    time: 1700000000 + i * 300, open: 100, high: 110, low: 90, close: 100, volume: 0,
  }))

  beforeEach(() => {
    refs = makeMockRefs()
    localStorage.clear()
    useDrawingHotkeysStore.getState().deactivate()
  })

  it('rect, fib and circle place via two clicks each', () => {
    for (const tool of ['rect', 'fib', 'circle'] as const) {
      localStorage.clear()
      const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
        initialProps: {
          symbol: 'BTCUSDT', tf: '5m', chartVersion: 1, isInitialLoading: false, refs, candlesData: candles,
        },
      })
      act(() => {
        useDrawingHotkeysStore.getState().activateTool(tool)
      })
      act(() => {
        result.current.handleClick({ clientX: 30, clientY: 100 } as MouseEvent)
      })
      expect(result.current.drawings.length).toBe(0)
      expect(result.current.pendingPoint).not.toBeNull()
      act(() => {
        result.current.handleClick({ clientX: 60, clientY: 200 } as MouseEvent)
      })
      expect(result.current.drawings.length).toBe(1)
      expect(result.current.drawings[0].type).toBe(tool)
      expect(result.current.pendingPoint).toBeNull()
    }
  })

  it('magnet snaps h-ray price to the nearest candle high/low', () => {
    // coordinateToPrice mock returns 100 for any y; magnet should override it
    // with the bar's high (110) or low (90) when within MAGNET_PX (3px).
    // Mock priceToCoordinate: y of high=110 → 100, y of low=90 → 120.
    refs.series.priceToCoordinate = vi.fn((price: number) =>
      price === 110 ? 100 : price === 90 ? 120 : 200,
    ) as never

    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT', tf: '5m', chartVersion: 1, isInitialLoading: false, refs, candlesData: candles,
      },
    })
    act(() => {
      useDrawingHotkeysStore.getState().activateTool('h-ray')
    })
    // clientX=30 → logical=5 → bar 5 (high=110, low=90).
    // clientY=100 → within 3px of high's coordinate (100) → snap to high=110.
    act(() => {
      result.current.handleClick({ clientX: 30, clientY: 100 } as MouseEvent)
    })
    expect(result.current.drawings.length).toBe(1)
    const d = result.current.drawings[0]
    const data = d.data as { price: number }
    expect(data.price).toBe(110)
  })

  it('magnet does not snap when far from high/low', () => {
    refs.series.priceToCoordinate = vi.fn((price: number) =>
      price === 110 ? 100 : price === 90 ? 120 : 200,
    ) as never

    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT', tf: '5m', chartVersion: 1, isInitialLoading: false, refs, candlesData: candles,
      },
    })
    act(() => {
      useDrawingHotkeysStore.getState().activateTool('h-ray')
    })
    // clientY=150 → 50px from both high/low → no snap, price stays 100 (mock).
    act(() => {
      result.current.handleClick({ clientX: 30, clientY: 150 } as MouseEvent)
    })
    expect(result.current.drawings.length).toBe(1)
    const d = result.current.drawings[0]
    const data = d.data as { price: number }
    expect(data.price).toBe(100)
  })
})

describe('useDrawings — price-alert tool', () => {
  let refs: MockRefs
  const candles: UnifiedCandle[] = Array.from({ length: 10 }, (_, i) => ({
    symbol: 'BTCUSDT', exchange: 'binance-futures', timeframe: '5m',
    time: 1700000000 + i * 300, open: 100, high: 110, low: 90, close: 100, volume: 0,
  }))

  beforeEach(() => {
    refs = makeMockRefs()
    localStorage.clear()
    useDrawingHotkeysStore.getState().deactivate()
    mockPost.mockClear()
  })

  it('places a dashed h-ray and creates a price alert on click', () => {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT', tf: '5m', chartVersion: 1, isInitialLoading: false, refs, candlesData: candles,
      },
    })
    act(() => {
      useDrawingHotkeysStore.getState().activateTool('alert')
    })
    act(() => {
      result.current.handleClick({ clientX: 60, clientY: 120 } as MouseEvent)
    })

    expect(result.current.drawings.length).toBe(1)
    const d = result.current.drawings[0]
    expect(d.type).toBe('h-ray') // visual line reuses the h-ray type
    const data = d.data as { price: number; style?: string }
    expect(data.price).toBe(100) // mock coordinateToPrice
    expect(data.style).toBe('dashed') // alert rays render amber/dashed

    // Clicked at 100 while the coin's price is 110 → direction 'below'.
    expect(mockPost).toHaveBeenCalledWith('/alerts', {
      type: 'price',
      symbol: 'BTCUSDT',
      exchange: 'binance-futures',
      condition: { price: 100, direction: 'below' },
    })
  })

  it('deactivates the tool after placing (one click per alert)', () => {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT', tf: '5m', chartVersion: 1, isInitialLoading: false, refs, candlesData: candles,
      },
    })
    act(() => {
      useDrawingHotkeysStore.getState().activateTool('alert')
    })
    act(() => {
      result.current.handleClick({ clientX: 60, clientY: 120 } as MouseEvent)
    })
    expect(useDrawingHotkeysStore.getState().activeTool).toBeNull()
  })
})
