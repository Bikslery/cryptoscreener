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
  pane: { attachPrimitive: ReturnType<typeof vi.fn>; detachPrimitive: ReturnType<typeof vi.fn> }
}

function makeMockRefs(): MockRefs {
  const pane = {
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
  }
  const timeScale: Partial<ITimeScaleApi<Time>> = {
    timeToCoordinate: vi.fn(() => null),
    getVisibleLogicalRange: vi.fn(() => null),
    getVisibleRange: vi.fn(() => null),
    logicalToCoordinate: vi.fn(() => null),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  }
  const series = {
    priceToCoordinate: vi.fn(() => 200),
    coordinateToPrice: vi.fn(() => 100),
  } as unknown as ISeriesApi<'Candlestick'>
  const chart = {
    panes: vi.fn(() => [pane]),
    timeScale: vi.fn(() => timeScale as ITimeScaleApi<Time>),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  } as unknown as IChartApi
  const container = { clientWidth: 800, clientHeight: 400 } as HTMLDivElement
  return { chart, series, container, pane }
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
  // Keep the ref in sync with the latest prop between renders.
  useLayoutEffect(() => {
    candlesDataRef.current = props.candlesData ?? []
  })
  // Sync refs to latest mock between renders. useLayoutEffect runs after
  // render but before the SUT's useEffects, so the mocked chart/series
  // are in place by the time useDrawings' attach + sync effects fire.
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
    expect(refs.pane.attachPrimitive).not.toHaveBeenCalled()
    expect(result.current.primitiveRef.current).toBeNull()
  })

  it('attaches a primitive once data has loaded', () => {
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
    expect(refs.pane.attachPrimitive).toHaveBeenCalledTimes(1)
    expect(result.current.primitiveRef.current).not.toBeNull()
  })

  // Regression: when tf changes, the chart is recreated, isInitialLoading
  // flips true→false as the new data loads, and a NEW primitive is attached
  // to the new chart. The bug was that the sync useEffect didn't re-run on
  // the false transition (its dep list omitted isInitialLoading), so the
  // newly-attached primitive had its internal _drawings set to the empty
  // initial state — drawings effectively "disappeared" on every TF change.
  it('re-syncs drawings to the new primitive after a TF change', () => {
    // Seed localStorage with a saved drawing so the hook loads it on mount.
    const drawing = {
      id: 'local-1',
      userId: '',
      symbol: 'BTCUSDT',
      type: 'h-ray',
      data: { price: 100, time: 1700000000, logical: 0 },
    }
    localStorage.setItem('drawings:BTCUSDT', JSON.stringify([drawing]))

    // Spy on the prototype BEFORE any new primitive is constructed, so the
    // spy is in place when the TF-change effect fires.
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
    // First load: data arrives, primitive attaches, drawings are synced.
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

    // TF change: chart re-created, isInitialLoading flips true→false.
    // The new primitive must receive the drawings.
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
    // While loading the new TF, no primitive is attached to the new chart.
    expect(refs2.pane.attachPrimitive).not.toHaveBeenCalled()

    act(() => {
      rerender({
        symbol: 'BTCUSDT',
        tf: '15m',
        chartVersion: 1,
        isInitialLoading: false,
        refs: refs2,
      })
    })
    expect(refs2.pane.attachPrimitive).toHaveBeenCalledTimes(1)
    const newPrimitive = result.current.primitiveRef.current
    expect(newPrimitive).not.toBeNull()
    expect(newPrimitive).not.toBe(firstPrimitive)

    // The sync effect must have re-run on the false transition and pushed
    // the existing drawings into the NEW primitive. The prototype spy catches
    // the call because it was wired up before the new instance was built.
    expect(setDrawingsSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstLoad)
    const lastCall = setDrawingsSpy.mock.calls[setDrawingsSpy.mock.calls.length - 1]
    const drawingsArg = lastCall[0] as Array<{ id: string }>
    expect(drawingsArg.map(d => d.id)).toContain('local-1')
  })
})
