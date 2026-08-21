import { describe, expect, it, vi } from 'vitest'
import type { IChartApi } from 'lightweight-charts'
import {
  canPaintPartialHistory,
  replaceDataPreservingPriceScale,
  resolveHistoryViewportAction,
} from '../chart-history-paint'

describe('chart history background paint policy', () => {
  it('keeps the current viewport when deeper history arrives after first paint', () => {
    expect(resolveHistoryViewportAction({
      hasViewport: true,
      fitOnOpen: true,
    })).toBe('restore')
  })

  it('fits an expanded chart only on its first paint', () => {
    expect(resolveHistoryViewportAction({
      hasViewport: false,
      fitOnOpen: true,
    })).toBe('fit')
  })

  it('opens mini charts on their recent window', () => {
    expect(resolveHistoryViewportAction({
      hasViewport: false,
      fitOnOpen: false,
    })).toBe('recent')
  })

  it('can immediately paint any non-empty websocket/cache tail', () => {
    expect(canPaintPartialHistory(64)).toBe(true)
    expect(canPaintPartialHistory(1)).toBe(true)
    expect(canPaintPartialHistory(0)).toBe(false)
  })

  it('locks the visible price range while deeper history replaces the series', () => {
    const state = {
      autoScale: true,
      range: { from: 95, to: 105 },
    }
    const scheduled: FrameRequestCallback[] = []
    const priceScale = {
      options: () => ({ autoScale: state.autoScale }),
      getVisibleRange: () => state.range,
      setAutoScale: vi.fn((on: boolean) => { state.autoScale = on }),
      setVisibleRange: vi.fn((range: { from: number; to: number }) => { state.range = range }),
    }
    const chart = { priceScale: () => priceScale } as unknown as IChartApi
    let autoScaleDuringReplace = true

    replaceDataPreservingPriceScale(
      chart,
      () => {
        autoScaleDuringReplace = state.autoScale
        // This is the lightweight-charts jump we are guarding against:
        // setData auto-fits the newly enlarged data set while autoscale is on.
        if (state.autoScale) state.range = { from: 1, to: 1_000 }
      },
      callback => {
        scheduled.push(callback)
        return scheduled.length
      },
    )

    expect(autoScaleDuringReplace).toBe(false)
    expect(state.range).toEqual({ from: 95, to: 105 })
    expect(state.autoScale).toBe(false)
    expect(scheduled).toHaveLength(1)

    scheduled[0](0)
    expect(state.autoScale).toBe(true)
  })

  it('keeps a manually fixed price scale fixed after history replacement', () => {
    const state = { autoScale: false, range: { from: 95, to: 105 } }
    const priceScale = {
      options: () => ({ autoScale: state.autoScale }),
      getVisibleRange: () => state.range,
      setAutoScale: vi.fn((on: boolean) => { state.autoScale = on }),
      setVisibleRange: vi.fn((range: { from: number; to: number }) => { state.range = range }),
    }
    const chart = { priceScale: () => priceScale } as unknown as IChartApi
    const schedule = vi.fn()

    replaceDataPreservingPriceScale(chart, () => {}, schedule)

    expect(state.autoScale).toBe(false)
    expect(state.range).toEqual({ from: 95, to: 105 })
    expect(schedule).not.toHaveBeenCalled()
  })

  it('still replaces data when the price scale is unavailable', () => {
    const replace = vi.fn()
    const chart = {
      priceScale: () => { throw new Error('chart disposed') },
    } as unknown as IChartApi

    replaceDataPreservingPriceScale(chart, replace)

    expect(replace).toHaveBeenCalledOnce()
  })

  it('still replaces first-paint data when no visible price range exists yet', () => {
    const replace = vi.fn()
    const priceScale = {
      options: () => ({ autoScale: true }),
      getVisibleRange: () => null,
    }
    const chart = { priceScale: () => priceScale } as unknown as IChartApi

    replaceDataPreservingPriceScale(chart, replace)

    expect(replace).toHaveBeenCalledOnce()
  })

  it('releases autoscale immediately when animation-frame scheduling fails', () => {
    const state = { autoScale: true, range: { from: 95, to: 105 } }
    const priceScale = {
      options: () => ({ autoScale: state.autoScale }),
      getVisibleRange: () => state.range,
      setAutoScale: vi.fn((on: boolean) => { state.autoScale = on }),
      setVisibleRange: vi.fn(),
    }
    const chart = { priceScale: () => priceScale } as unknown as IChartApi

    replaceDataPreservingPriceScale(chart, () => {}, () => { throw new Error('RAF unavailable') })

    expect(state.autoScale).toBe(true)
  })

  it('uses the browser animation frame by default', () => {
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback)
      return callbacks.length
    }))
    const state = { autoScale: true, range: { from: 95, to: 105 } }
    const priceScale = {
      options: () => ({ autoScale: state.autoScale }),
      getVisibleRange: () => state.range,
      setAutoScale: vi.fn((on: boolean) => { state.autoScale = on }),
      setVisibleRange: vi.fn(),
    }
    const chart = { priceScale: () => priceScale } as unknown as IChartApi

    replaceDataPreservingPriceScale(chart, () => {})

    expect(callbacks).toHaveLength(1)
    callbacks[0](0)
    expect(state.autoScale).toBe(true)
    vi.unstubAllGlobals()
  })
})
