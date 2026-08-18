import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ISeriesApi, SeriesType } from 'lightweight-charts'

// FormingAnimator lives in ChartGrid.tsx (exported for tests). Importing the
// module executes its top-level side effects (candle-diag's
// attachDiagToWindow, zustand store creation) — all harmless in jsdom and
// already exercised by the existing useDrawings tests that import sibling
// chart modules, so no additional mocking is needed here.
import { FormingAnimator } from '../ChartGrid'
import { toChartTime } from '../../../services/candle-events'

// Deterministic rAF: the shared glide.ts coordinator schedules
// requestAnimationFrame itself: replace it with a manually-driven queue so
// tests can advance frame-by-frame without real timing.
let rafCallbacks: FrameRequestCallback[] = []
function flushRaf(now: number) {
  const cbs = rafCallbacks
  rafCallbacks = []
  for (const cb of cbs) cb(now)
}

// Deterministic clock: the animator snaps on live pairs (paints <= 80ms
// apart) and glides on quiet ones, so tests control `now` explicitly.
let nowValue = 0

beforeEach(() => {
  rafCallbacks = []
  nowValue = 0
  vi.spyOn(performance, 'now').mockImplementation(() => nowValue)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb)
    return rafCallbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => { /* no-op for this test's purposes */ })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function makeSeries() {
  const updates: { time: number; open?: number; high?: number; low?: number; close?: number; value?: number; historicalUpdate?: boolean }[] = []
  const series = {
    update: vi.fn((bar: { time: number; open?: number; high?: number; low?: number; close?: number; value?: number }, historicalUpdate?: boolean) => {
      updates.push({ ...bar, historicalUpdate })
    }),
  } as unknown as ISeriesApi<SeriesType>
  return { series, updates }
}

describe('FormingAnimator — live pairs SNAP (стакан parity)', () => {
  it('snaps straight to the target on a live pair (updates <= 80ms apart)', () => {
    const { series, updates } = makeSeries()
    const animator = new FormingAnimator(series, () => series)

    nowValue = 0
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 100, high: 101, low: 99, close: 100, volume: 1 })
    expect(animator.isAnimating).toBe(false) // first paint snaps immediately, no glide yet

    // 10ms later — a live pair retarget: the body must move EXACTLY to the
    // new price (like the стакан), not interpolate.
    nowValue = 10
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 100, high: 102, low: 99, close: 101.5, volume: 1 })

    expect(animator.isAnimating).toBe(false) // snapped — no glide registered
    const last = updates[updates.length - 1]
    expect(last.time).toBe(toChartTime(300))
    expect(last.close).toBe(101.5) // exact target, zero chase
    expect(last.high).toBe(102)
    flushRaf(16.7)
    expect(updates.length).toBe(2) // no extra glide frames
  })

  it('glides smoothly on a quiet pair (updates > 80ms apart)', () => {
    const { series, updates } = makeSeries()
    const animator = new FormingAnimator(series, () => series)

    nowValue = 0
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 100, high: 101, low: 99, close: 100, volume: 1 })
    nowValue = 200 // quiet interval → glide, not snap
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 100, high: 102, low: 99, close: 101.5, volume: 1 })
    expect(animator.isAnimating).toBe(true)

    flushRaf(16.7)
    const partial = updates[updates.length - 1]
    expect(partial.close).toBeGreaterThan(100)
    expect(partial.close).toBeLessThan(101.5) // mid-glide, not yet converged

    // Leave the shared coordinator in a clean state for the next test.
    animator.finalizeAndReset()
  })
})

describe('FormingAnimator — bar-transition handoff (Stage 2 item 3)', () => {
  it('finalizes the previous bar to its exact last target before snapping to a new bar (paint() path)', () => {
    const { series, updates } = makeSeries()
    const animator = new FormingAnimator(series, () => series)

    // Bar A forming: paint moves the target, animator starts gliding
    // (quiet pair: updates 200ms apart).
    nowValue = 0
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 100, high: 101, low: 99, close: 100, volume: 1 })
    expect(animator.isAnimating).toBe(false) // first paint snaps immediately, no glide yet
    nowValue = 200
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 100, high: 102, low: 99, close: 101.5, volume: 1 })
    expect(animator.isAnimating).toBe(true) // now gliding toward close=101.5

    // Advance one frame — displayed moves PARTWAY toward target (not fully).
    flushRaf(16.7)
    const partial = updates[updates.length - 1]
    expect(partial.close).toBeGreaterThan(100)
    expect(partial.close).toBeLessThan(101.5) // mid-glide, not yet converged

    // Bar B arrives (a NEW period) — handoff via paint(): the OLD bar (300)
    // must be finalized to its exact last target (close=101.5) BEFORE the
    // new bar's exact snap is painted, so it never freezes on the partial
    // interpolated frame once it's no longer the series' last bar.
    nowValue = 400
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 360, open: 101.5, high: 101.5, low: 101.5, close: 101.5, volume: 0 })

    const finalizeCall = updates[updates.length - 2]
    const newBarCall = updates[updates.length - 1]
    expect(finalizeCall.time).toBe(toChartTime(300))
    expect(finalizeCall.close).toBe(101.5) // exact target, not the mid-glide value
    expect(newBarCall.time).toBe(toChartTime(360))
    expect(newBarCall.close).toBe(101.5)
  })

  it('finalizeAndReset (exact-paint handoff path) snaps the old bar before applyChartPatch paints the new one exactly', () => {
    const { series, updates } = makeSeries()
    const animator = new FormingAnimator(series, () => series)

    nowValue = 0
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 10, high: 10, low: 10, close: 10, volume: 1 })
    nowValue = 200
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 10, high: 13, low: 10, close: 12, volume: 1 })
    expect(animator.isAnimating).toBe(true)
    flushRaf(16.7) // partial glide frame, close somewhere between 10 and 12

    // applyChartPatch's "new period / full snapshot" branch calls this
    // instead of paint() when isFormingBar() is false for the incoming bar.
    animator.finalizeAndReset()

    const finalizeCall = updates[updates.length - 1]
    expect(finalizeCall.time).toBe(toChartTime(300))
    expect(finalizeCall.close).toBe(12) // exact target snap, not a stale partial frame
    expect(animator.isAnimating).toBe(false)
  })

  it('reset() (setData path) does NOT repaint — setData is about to overwrite the whole series anyway', () => {
    const { series, updates } = makeSeries()
    const animator = new FormingAnimator(series, () => series)

    nowValue = 0
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 10, high: 10, low: 10, close: 10, volume: 1 })
    nowValue = 200
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 10, high: 13, low: 10, close: 12, volume: 1 })
    expect(animator.isAnimating).toBe(true)
    const callsBeforeReset = updates.length

    animator.reset()

    expect(updates.length).toBe(callsBeforeReset) // no extra series.update() call
    expect(animator.isAnimating).toBe(false)
  })

  it('unregisters from the shared rAF coordinator on finalizeAndReset/reset — no zombie glide after handoff', () => {
    const { series } = makeSeries()
    const animator = new FormingAnimator(series, () => series)

    nowValue = 0
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 10, high: 10, low: 10, close: 10, volume: 1 })
    nowValue = 200
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 10, high: 13, low: 10, close: 12, volume: 1 })
    expect(rafCallbacks.length).toBe(1) // registered with the shared coordinator

    animator.finalizeAndReset()
    // tick() would now be a no-op even if a stray rAF callback fired, since
    // displayed/target are cleared — but the real assertion is `running`:
    expect(animator.isAnimating).toBe(false)
  })

  it('a stale series (chart removed) fails paintSeries gracefully and clears state without recursing', () => {
    const series = {
      update: vi.fn(() => { throw new Error('series disposed') }),
    } as unknown as ISeriesApi<SeriesType>
    const animator = new FormingAnimator(series, () => series)

    nowValue = 0
    animator.paint({ symbol: 'X', exchange: 'binance-futures', timeframe: '1m', time: 300, open: 10, high: 10, low: 10, close: 10, volume: 1 })
    // First paint() call already hits paintSeries which throws — must not
    // throw OUT of paint() itself, and must leave the animator inert.
    expect(animator.isAnimating).toBe(false)

    expect(() => animator.finalizeAndReset()).not.toThrow()
  })
})
