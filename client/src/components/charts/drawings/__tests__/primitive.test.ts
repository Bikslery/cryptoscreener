import { describe, it, expect, vi } from 'vitest'
import type { IChartApi, ITimeScaleApi, Time, UTCTimestamp } from 'lightweight-charts'
import { timeToPixel } from '../primitive'

const t = (n: number): UTCTimestamp => n as UTCTimestamp

function makeChart(opts: {
  timeToCoord?: (t: unknown) => number | null
  visibleLogical?: { from: number; to: number } | null
  visibleTime?: { from: number; to: number } | null
  logicalToCoord?: (l: number) => number | null
}): IChartApi {
  const ts = {
    timeToCoordinate: vi.fn((time: Time) => (opts.timeToCoord ? opts.timeToCoord(time) : null)),
    getVisibleLogicalRange: vi.fn(() => opts.visibleLogical ?? null),
    getVisibleRange: vi.fn(() => opts.visibleTime ?? null),
    logicalToCoordinate: vi.fn((l: number) => (opts.logicalToCoord ? opts.logicalToCoord(l) : null)),
  }
  return { timeScale: () => ts as unknown as ITimeScaleApi<Time> } as unknown as IChartApi
}

describe('drawings/timeToPixel', () => {
  it('returns the value from timeToCoordinate when it is available', () => {
    const chart = makeChart({ timeToCoord: () => 123.5 })
    expect(timeToPixel(chart, t(1700000000))).toBe(123.5)
  })

  it('returns null when time is null or undefined', () => {
    const chart = makeChart({})
    expect(timeToPixel(chart, null as never)).toBeNull()
    expect(timeToPixel(chart, undefined as never)).toBeNull()
  })

  it('returns null when time is NaN or Infinity', () => {
    const chart = makeChart({})
    expect(timeToPixel(chart, NaN as never)).toBeNull()
    expect(timeToPixel(chart, Infinity as never)).toBeNull()
    expect(timeToPixel(chart, -Infinity as never)).toBeNull()
  })

  // Regression: cause #1 of the "drawings slide on TF change" bug.
  // When the chart has no visible range yet (e.g. just after chart creation
  // before setData, or right after a TF/symbol change while the new data is
  // loading), timeToCoordinate returns null AND getVisibleLogicalRange /
  // getVisibleRange return null. The previous implementation fell back to
  // `logicalToCoordinate(storedLogical)` — but that logical was sampled on a
  // different TF and maps to a wrong pixel here. The fix is to return null
  // and let LWC drive a fresh paint once data is loaded.
  it('returns null on empty chart and does NOT fall back to a stored logical', () => {
    const logicalToCoord = vi.fn((l: number) => 42 + l)
    const chart = makeChart({
      timeToCoord: () => null,
      visibleLogical: null,
      visibleTime: null,
      logicalToCoord,
    })
    expect(timeToPixel(chart, t(1700000000))).toBeNull()
    expect(logicalToCoord).not.toHaveBeenCalled()
  })

  it('returns null when only the visible logical range is missing', () => {
    const chart = makeChart({
      timeToCoord: () => null,
      visibleLogical: null,
      visibleTime: { from: 1700000000, to: 1700010000 },
      logicalToCoord: (l) => 42 + l,
    })
    expect(timeToPixel(chart, t(1700000000))).toBeNull()
  })

  it('returns null when only the visible time range is missing', () => {
    const chart = makeChart({
      timeToCoord: () => null,
      visibleLogical: { from: 0, to: 100 },
      visibleTime: null,
      logicalToCoord: (l) => 42 + l,
    })
    expect(timeToPixel(chart, t(1700000000))).toBeNull()
  })

  it('uses linear interpolation when the time is outside the visible bar range', () => {
    // timeToCoordinate is null (time is outside the cached bar coordinates),
    // but the visible ranges are populated. We expect logicalToCoordinate to
    // be called with an interpolated logical that corresponds to the target
    // time, not with any externally-stored value.
    const logicalToCoord = vi.fn((l: number) => l * 2)
    const chart = makeChart({
      timeToCoord: () => null,
      visibleLogical: { from: 0, to: 100 },
      visibleTime: { from: 1700000000, to: 1700001000 },
      logicalToCoord,
    })
    const px = timeToPixel(chart, t(1700000500))
    // Midpoint of time range → midpoint of logical range (50) → 100px
    expect(px).toBe(100)
    expect(logicalToCoord).toHaveBeenCalledTimes(1)
  })

  it('returns null when the visible logical range collapses to a single point', () => {
    const chart = makeChart({
      timeToCoord: () => null,
      visibleLogical: { from: 50, to: 50 },
      visibleTime: { from: 1700000000, to: 1700001000 },
    })
    expect(timeToPixel(chart, t(1700000500))).toBeNull()
  })
})
