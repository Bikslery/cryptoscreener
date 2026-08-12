import { describe, it, expect } from 'vitest'
import { sanitizeCandle, sanitizeSeries, contextWindow, CONTEXT_WINDOW } from '../candle-sanity'
import { validateCandle } from '../candle-utils'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance-futures'
const SYM = 'TESTUSDT'
const TF = '5m'

function mk(time: number, close: number, range = 1): UnifiedCandle {
  return {
    symbol: SYM, exchange: EX, timeframe: TF, time,
    open: close, high: close + range, low: close - range, close,
    volume: 100, source: 'kline' as const,
  }
}

function ctx(n = 8): UnifiedCandle[] {
  const out: UnifiedCandle[] = []
  for (let i = 0; i < n; i++) out.push(mk(1000 + i * 300, 100 + (i % 3), 1))
  return out
}

describe('candle-sanity', () => {
  it('leaves a normal candle completely untouched', () => {
    const c = mk(3400, 101.4, 0.8)
    const got = sanitizeCandle(c, ctx())
    expect(got).toEqual(c)
  })

  it('flags and clamps a phantom giant candle (range + price order off)', () => {
    const fake: UnifiedCandle = { ...mk(3400, 100.5), high: 100 * 120, low: 100 * 10, open: 100 * 60, close: 100 * 60 }
    const got = sanitizeCandle(fake, ctx())
    // Clamped back into the neighbours' band, time and identity preserved.
    expect(got.time).toBe(3400)
    expect(got.symbol).toBe(SYM)
    expect(got.high).toBeLessThan(500)
    expect(got.low).toBeGreaterThan(50)
    expect(validateCandle(got)).toBe(true)
  })

  it('rebuilds a non-finite candle as a flat bar at the median close', () => {
    const nan: UnifiedCandle = { ...mk(3400, NaN, NaN) }
    const got = sanitizeCandle(nan, ctx())
    expect(got.open).toBe(got.high)
    expect(got.high).toBe(got.low)
    expect(got.close).toBe(got.high)
    expect(validateCandle(got)).toBe(true)
  })

  it('does nothing when there is too little context', () => {
    const c = mk(3400, 100)
    expect(sanitizeCandle(c, [mk(1000, 100)])).toBe(c)
    expect(sanitizeCandle(c, [])).toBe(c)
  })

  it('sanitizeSeries keeps the series contiguous and valid when one row is garbage', () => {
    const series = ctx(20).map((c, i) => (i === 10 ? { ...c, high: 1e6, low: -1e6, open: 1e5, close: 1e5 } : c))
    const out = sanitizeSeries(series, 'history')
    expect(out).toHaveLength(series.length)
    expect(out.map(c => c.time)).toEqual(series.map(c => c.time).sort((a, b) => a - b))
    expect(out.every(validateCandle)).toBe(true)
    expect(out[10].high).toBeLessThan(1e4)
    expect(out[10].low).toBeGreaterThan(-1e4)
  })

  it('contextWindow returns predecessors only, bounded by the window', () => {
    const arr = ctx(20)
    expect(contextWindow(arr, -1)).toHaveLength(CONTEXT_WINDOW)
    expect(contextWindow(arr, 5).length).toBe(5)
    expect(contextWindow(arr, 5).every((c, i) => i === 0 || c.time < arr[5].time)).toBe(true)
  })
})
