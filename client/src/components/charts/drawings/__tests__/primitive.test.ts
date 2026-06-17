import { describe, it, expect, vi } from 'vitest'
import type { IChartApi, ITimeScaleApi, Time, UTCTimestamp } from 'lightweight-charts'
import type { UnifiedCandle } from '../../../../types'
import { timeToPixel, findBarByTime, resolveExactX } from '../primitive'

const t = (n: number): UTCTimestamp => n as UTCTimestamp

function makeChart(opts: {
  timeToCoord?: (t: unknown) => number | null
  logicalToCoord?: (l: number) => number | null
  barSpacing?: number
}): IChartApi {
  const ts = {
    timeToCoordinate: vi.fn((time: Time) => (opts.timeToCoord ? opts.timeToCoord(time) : null)),
    logicalToCoordinate: vi.fn((l: number) => (opts.logicalToCoord ? opts.logicalToCoord(l) : null)),
    options: vi.fn(() => ({ barSpacing: opts.barSpacing ?? 6 })),
  }
  return { timeScale: () => ts as unknown as ITimeScaleApi<Time> } as unknown as IChartApi
}

// Synthetic 1h candle series: 24 bars starting at 1700000000.
const ONE_HOUR = 3600
const HOUR_0 = 1700000000
function makeHourlyCandles(count: number, start = HOUR_0, step = ONE_HOUR): UnifiedCandle[] {
  const out: UnifiedCandle[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      symbol: 'BTCUSDT',
      exchange: 'binance-spot',
      timeframe: '1h',
      time: start + i * step,
      open: 100, high: 100, low: 100, close: 100, volume: 0,
    })
  }
  return out
}

describe('drawings/timeToPixel', () => {
  it('returns the value from timeToCoordinate when it is available', () => {
    const chart = makeChart({ timeToCoord: () => 123.5 })
    expect(timeToPixel(chart, null, t(1700000000))).toBe(123.5)
  })

  it('returns null when time is null or undefined', () => {
    const chart = makeChart({})
    expect(timeToPixel(chart, null, null as never)).toBeNull()
    expect(timeToPixel(chart, null, undefined as never)).toBeNull()
  })

  it('returns null when time is NaN or Infinity', () => {
    const chart = makeChart({})
    expect(timeToPixel(chart, null, NaN as never)).toBeNull()
    expect(timeToPixel(chart, null, Infinity as never)).toBeNull()
    expect(timeToPixel(chart, null, -Infinity as never)).toBeNull()
  })

  // Regression: cause #1 of the "drawings slide on TF change" bug.
  // When the chart has no visible range yet (e.g. just after chart creation
  // before setData, or right after a TF/symbol change while the new data is
  // loading), timeToCoordinate returns null AND no candle data is loaded.
  // The function must return null and not synthesise a pixel from a stale
  // logical. LWC will redraw once the new data arrives.
  it('returns null when timeToCoordinate fails AND no candle data is loaded', () => {
    const logicalToCoord = vi.fn((l: number) => 42 + l)
    const chart = makeChart({ logicalToCoord })
    expect(timeToPixel(chart, null, t(1700000000))).toBeNull()
    expect(logicalToCoord).not.toHaveBeenCalled()
  })

  it('returns null when timeToCoordinate fails AND candle data is empty', () => {
    const logicalToCoord = vi.fn((l: number) => 42 + l)
    const chart = makeChart({ logicalToCoord })
    expect(timeToPixel(chart, [], t(1700000000))).toBeNull()
    expect(logicalToCoord).not.toHaveBeenCalled()
  })

  // The core regression for the "drawings slide / second point teleports on
  // TF change" bug. A user draws on a 1m chart at 14:23:15 — the stored
  // time is 14:23:00 (a 1m bar time). After switching to 1h, that time is
  // no longer an exact bar time, so `timeToCoordinate` returns null. The
  // fix: find the 1h bar that contains 14:23 (the 14:00 bar) and ask LWC
  // for that bar's logical pixel — which yields a stable, correct position.
  it('finds the containing bar via binary search when timeToCoordinate fails', () => {
    const candles = makeHourlyCandles(24)
    const logicalToCoord = vi.fn((l: number) => l * 10) // 10px per bar
    const chart = makeChart({ logicalToCoord })

    // 14:23:00 on a 1h chart lives inside the 14:00 bar (index 14).
    // stored time = 14:23:00 = HOUR_0 + 14 * 3600 + 23 * 60
    const t1423 = HOUR_0 + 14 * 3600 + 23 * 60
    const px = timeToPixel(chart, candles, t(t1423))

    expect(px).toBe(140) // bar 14 → 140px
    expect(logicalToCoord).toHaveBeenCalledWith(14)
  })

  it('snaps to the exact bar when the time is a bar boundary', () => {
    const candles = makeHourlyCandles(24)
    const logicalToCoord = vi.fn((l: number) => l * 10)
    const chart = makeChart({ logicalToCoord })

    // Exact 1h bar at 15:00:00 → index 15 → 150px
    const t1500 = HOUR_0 + 15 * 3600
    expect(timeToPixel(chart, candles, t(t1500))).toBe(150)
    expect(logicalToCoord).toHaveBeenCalledWith(15)
  })

  it('returns null when the time is before the first loaded bar', () => {
    const candles = makeHourlyCandles(24)
    const logicalToCoord = vi.fn((l: number) => l * 10)
    const chart = makeChart({ logicalToCoord })

    const before = HOUR_0 - 1
    expect(timeToPixel(chart, candles, t(before))).toBeNull()
    expect(logicalToCoord).not.toHaveBeenCalled()
  })

  it('snaps to the last bar when the time is after the last loaded bar', () => {
    const candles = makeHourlyCandles(24)
    const logicalToCoord = vi.fn((l: number) => l * 10)
    const chart = makeChart({ logicalToCoord })

    // 100h in the future — past the end of the data. LWC's
    // logicalToCoordinate will return null when the logical is outside
    // the visible range, which is the off-screen case.
    const farFuture = HOUR_0 + 100 * 3600
    const px = timeToPixel(chart, candles, t(farFuture))
    // Index 23 is the last bar. The mock returns 23 * 10 = 230 here;
    // in production LWC would return null because 23 isn't in the
    // visible range, but the lookup is correct: we found the right bar.
    expect(px).toBe(230)
    expect(logicalToCoord).toHaveBeenCalledWith(23)
  })

  it('prefers the cached timeToCoordinate result over the binary search', () => {
    // When timeToCoordinate works (exact bar match in LWC's cache), the
    // function should return that value and not bother with candle data.
    const logicalToCoord = vi.fn((l: number) => l * 999)
    const chart = makeChart({
      timeToCoord: () => 777,
      logicalToCoord,
    })
    const candles = makeHourlyCandles(24)
    expect(timeToPixel(chart, candles, t(HOUR_0 + 5 * 3600))).toBe(777)
    expect(logicalToCoord).not.toHaveBeenCalled()
  })

  it('handles a BusinessDay Time on 1d/1w/1M timeframes (1d bar)', () => {
    // On 1d+ TFs LWC may return a BusinessDay {year, month, day} from
    // `coordinateToTime`. The conversion must yield the correct UNIX
    // midnight for that day (UTC).
    const logicalToCoord = vi.fn((l: number) => l * 10)
    const chart = makeChart({ logicalToCoord })

    // 2023-11-14 in UTC. We place the candle at exactly that midnight
    // so findBarByTime should return its index.
    const dayCandle: UnifiedCandle = {
      symbol: 'BTCUSDT',
      exchange: 'binance-spot',
      timeframe: '1d',
      time: Math.floor(Date.UTC(2023, 10, 14) / 1000), // month is 0-indexed
      open: 100, high: 100, low: 100, close: 100, volume: 0,
    }
    const data = [dayCandle]

    const px = timeToPixel(chart, data, {
      year: 2023, month: 11, day: 14,
    } as unknown as Time)
    expect(px).toBe(0)
    expect(logicalToCoord).toHaveBeenCalledWith(0)
  })
})

describe('drawings/findBarByTime', () => {
  it('returns null for empty / null candle data', () => {
    expect(findBarByTime(null, 100)).toBeNull()
    expect(findBarByTime(undefined, 100)).toBeNull()
    expect(findBarByTime([], 100)).toBeNull()
  })

  it('returns null for non-finite target times', () => {
    const candles = makeHourlyCandles(10)
    expect(findBarByTime(candles, NaN)).toBeNull()
    expect(findBarByTime(candles, Infinity)).toBeNull()
    expect(findBarByTime(candles, -Infinity)).toBeNull()
  })

  it('returns null when target is before the first bar', () => {
    const candles = makeHourlyCandles(10)
    expect(findBarByTime(candles, HOUR_0 - 1)).toBeNull()
  })

  it('returns the index of the exact bar when the time matches', () => {
    const candles = makeHourlyCandles(10)
    expect(findBarByTime(candles, HOUR_0 + 5 * 3600)).toBe(5)
  })

  it('returns the rightmost bar <= target for sub-bar times', () => {
    const candles = makeHourlyCandles(10)
    // 14:23:00 on a 1h chart → bar at 14:00 (index 14), but we only have
    // 10 bars. Use a time halfway between bars 3 and 4.
    const target = HOUR_0 + 3 * 3600 + 30 * 60 // 03:30
    expect(findBarByTime(candles, target)).toBe(3)
  })

  it('returns the last index for times at or after the last bar', () => {
    const candles = makeHourlyCandles(10)
    expect(findBarByTime(candles, candles[9].time)).toBe(9)
    expect(findBarByTime(candles, candles[9].time + 1000000)).toBe(9)
  })

  // The actual scenario the user hit: drawing on 1m at 14:23:15, the
  // stored time is 14:23:00 (1m bar). After switching to 1h the new data
  // has 1h bars at 14:00, 15:00, …. findBarByTime(14:23:00) on 1h data
  // must return the index of the 14:00 bar.
  it('TF-change regression: 1m click time 14:23 resolves to the 14:00 bar on 1h data', () => {
    const oneHourData = makeHourlyCandles(48)
    const t1423 = HOUR_0 + 14 * 3600 + 23 * 60 // 14:23:00
    expect(findBarByTime(oneHourData, t1423)).toBe(14)
  })
})

describe('drawings/resolveExactX', () => {
  it('returns exact pixel from float logical when within barSpacing of barX', () => {
    // Bar at x=100, logical=5.0. Click was at logical=5.3 → x≈118 (within barSpacing=20).
    const chart = makeChart({
      timeToCoord: () => 100,
      logicalToCoord: (l) => 100 + (l - 5) * 60, // 60px per bar unit
      barSpacing: 20,
    })
    const candles = makeHourlyCandles(10)
    // timeToCoordinate returns 100 (bar left edge), logicalToCoordinate(5.3) returns ~118.
    // |118 - 100| = 18 <= 20 → use exact.
    const result = resolveExactX(chart, candles, t(HOUR_0 + 5 * 3600), 5.3)
    expect(result).toBeCloseTo(118, 10)
  })

  it('falls back to timeToPixel when logical is stale (diff > barSpacing)', () => {
    // After a TF switch, logical=5.3 from the old TF might map to x=500
    // while the bar (time) maps to x=100. |500-100|=400 >> barSpacing=6.
    const chart = makeChart({
      timeToCoord: () => 100,
      logicalToCoord: () => 500,
      barSpacing: 6,
    })
    const candles = makeHourlyCandles(10)
    expect(resolveExactX(chart, candles, t(HOUR_0 + 5 * 3600), 5.3)).toBe(100)
  })

  it('falls back to timeToPixel when logical is undefined', () => {
    const chart = makeChart({ timeToCoord: () => 77 })
    const candles = makeHourlyCandles(10)
    expect(resolveExactX(chart, candles, t(HOUR_0 + 5 * 3600), undefined)).toBe(77)
  })

  it('falls back to timeToPixel when logical is NaN', () => {
    const chart = makeChart({ timeToCoord: () => 77 })
    const candles = makeHourlyCandles(10)
    expect(resolveExactX(chart, candles, t(HOUR_0 + 5 * 3600), NaN)).toBe(77)
  })

  it('returns exactX when barX is null but logical resolves', () => {
    // timeToCoordinate returns null (time not in visible range), but
    // logicalToCoordinate still gives a pixel — use it.
    const chart = makeChart({
      timeToCoord: () => null,
      logicalToCoord: () => 250,
      barSpacing: 6,
    })
    const candles = makeHourlyCandles(10)
    expect(resolveExactX(chart, candles, t(HOUR_0 + 5 * 3600), 5.3)).toBe(250)
  })

  it('returns null when both barX and exactX are null', () => {
    const chart = makeChart({
      timeToCoord: () => null,
      logicalToCoord: () => null,
    })
    const candles = makeHourlyCandles(10)
    expect(resolveExactX(chart, candles, t(HOUR_0 + 5 * 3600), 5.3)).toBeNull()
  })

  it('uses exactX when logical is exactly on bar boundary (diff=0)', () => {
    const chart = makeChart({
      timeToCoord: () => 100,
      logicalToCoord: () => 100,
      barSpacing: 6,
    })
    const candles = makeHourlyCandles(10)
    expect(resolveExactX(chart, candles, t(HOUR_0 + 5 * 3600), 5.0)).toBe(100)
  })
})
