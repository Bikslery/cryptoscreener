import { describe, it, expect, vi } from 'vitest'
import { captureViewport, restoreViewport, saveViewport, getViewport } from '../chart-viewport'
import type { IChartApi } from 'lightweight-charts'

function makeChart() {
  const state = {
    barSpacing: 6,
    rightOffset: 12,
    timeVisible: true,
    scrollPos: 5,
    restoredTo: 0,
    restoredAnimated: false,
  }
  const ts = {
    options: () => ({
      barSpacing: state.barSpacing,
      rightOffset: state.rightOffset,
      timeVisible: state.timeVisible,
    }),
    applyOptions: (o: Record<string, unknown>) => {
      if (o.barSpacing != null) state.barSpacing = o.barSpacing as number
      if (o.rightOffset != null) state.rightOffset = o.rightOffset as number
      if (o.timeVisible != null) state.timeVisible = o.timeVisible as boolean
    },
    scrollPosition: () => state.scrollPos,
    scrollToPosition: (pos: number, animated: boolean) => {
      state.restoredTo = pos
      state.restoredAnimated = animated
      state.scrollPos = pos
    },
  }
  return { chart: { timeScale: () => ts } as unknown as IChartApi, ts, state }
}

describe('chart-viewport (scalpboard Os/ae equivalent)', () => {
  it('captures barSpacing/rightOffset/timeVisible/scrollPosition', () => {
    const { chart, state } = makeChart()
    state.barSpacing = 9
    state.rightOffset = 24
    state.timeVisible = false
    state.scrollPos = -13
    const vp = captureViewport(chart)
    expect(vp).toEqual({ barSpacing: 9, rightOffset: 24, timeVisible: false, scrollPos: -13 })
  })

  it('restore re-applies the exact time-scale state (bar-to-pixel mapping)', () => {
    const { chart, state } = makeChart()
    state.barSpacing = 9
    state.rightOffset = 24
    state.timeVisible = false
    state.scrollPos = -13
    const vp = captureViewport(chart)

    state.barSpacing = 6
    state.rightOffset = 12
    state.timeVisible = true
    state.scrollPos = 5

    restoreViewport(chart, vp!)
    expect(state.barSpacing).toBe(9)
    expect(state.rightOffset).toBe(24)
    expect(state.timeVisible).toBe(false)
    expect(state.restoredTo).toBe(-13)
    expect(state.restoredAnimated).toBe(false)
  })

  it('capture returns null for a missing chart (defensive)', () => {
    expect(captureViewport(null)).toBeNull()
    expect(captureViewport(undefined)).toBeNull()
  })

  it('per-key persistence survives chart/symbol switches', () => {
    saveViewport('binance-futures:BTCUSDT:1m', { barSpacing: 9, rightOffset: 24, timeVisible: false, scrollPos: -13 })
    const vp = getViewport('binance-futures:BTCUSDT:1m')
    expect(vp?.barSpacing).toBe(9)
    expect(vp?.scrollPos).toBe(-13)
    expect(getViewport('binance-futures:ETHUSDT:1m')).toBeNull()
  })

  it('restore does not throw when the chart throws internally', () => {
    const { chart } = makeChart()
    const spy = vi.spyOn(chart.timeScale(), 'scrollToPosition').mockImplementation(() => { throw new Error('no data yet') })
    expect(() => restoreViewport(chart, { barSpacing: 9, rightOffset: 24, timeVisible: false, scrollPos: -13 })).not.toThrow()
    spy.mockRestore()
  })
})