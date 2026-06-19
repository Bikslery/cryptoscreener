import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef, useLayoutEffect, type RefObject } from 'react'
import type { IChartApi, ISeriesApi, ITimeScaleApi, Time } from 'lightweight-charts'
import type { UnifiedCandle } from '../../../types'
import { useDrawings } from '../useDrawings'
import { DrawingsPrimitive } from '../drawings/primitive'

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: [] })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}))

vi.mock('../../store', () => ({
  useAuthStore: <T,>(selector: (s: { isLoggedIn: boolean }) => T) =>
    selector({ isLoggedIn: false }),
  useCoinListStore: <T,>(selector: (s: { coinMap: Map<string, { pricePrecision: number }> }) => T) =>
    selector({ coinMap: new Map([['BTCUSDT', { pricePrecision: 2 }]]) }),
}))

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
    logicalToCoordinate: vi.fn(() => null),
    coordinateToTime: vi.fn(() => null),
    coordinateToLogical: vi.fn(() => null),
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
  const container = { clientWidth: 800, clientHeight: 400 } as HTMLDivElement
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

  it('does not attach a primitive while data is loading', () => {
    const { result } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 0,
        isInitialLoading: true,
        refs,
      },
    })
    expect(refs.attachPrimitive).not.toHaveBeenCalled()
    expect(result.current.primitiveRef.current).toBeNull()
  })

  it('attaches a primitive to the series once data has loaded', () => {
    const { result, rerender } = renderHook((p: HookProps) => useDrawingsHarness(p), {
      initialProps: {
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 0,
        isInitialLoading: true,
        refs,
      },
    })
    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 0,
        isInitialLoading: false,
        refs,
      })
    })
    expect(refs.attachPrimitive).toHaveBeenCalledTimes(1)
    expect(result.current.primitiveRef.current).not.toBeNull()
  })

  it('re-syncs drawings to the new primitive after a TF change', () => {
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
        chartVersion: 0,
        isInitialLoading: true,
        refs,
      },
    })
    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '5m',
        chartVersion: 0,
        isInitialLoading: false,
        refs,
      })
    })
    const firstPrimitive = result.current.primitiveRef.current
    expect(firstPrimitive).not.toBeNull()
    const callsAfterFirstLoad = setDrawingsSpy.mock.calls.length

    const refs2 = makeMockRefs()
    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '15m',
        chartVersion: 1,
        isInitialLoading: true,
        refs: refs2,
      })
    })
    expect(refs2.attachPrimitive).not.toHaveBeenCalled()

    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '15m',
        chartVersion: 1,
        isInitialLoading: false,
        refs: refs2,
      })
    })
    expect(refs2.attachPrimitive).toHaveBeenCalledTimes(1)
    const newPrimitive = result.current.primitiveRef.current
    expect(newPrimitive).not.toBeNull()
    expect(newPrimitive).not.toBe(firstPrimitive)

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
        chartVersion: 0,
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
        chartVersion: 0,
        isInitialLoading: false,
        refs,
      },
    })
    expect(typeof result.current.handleMouseDown).toBe('function')
    expect(typeof result.current.handleMouseUp).toBe('function')
  })
})
