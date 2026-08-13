import { describe, expect, it } from 'vitest'
import { detectPeaks, calcCascades, computeDensities, computeOverlays } from '../chart-overlays'
import type { UnifiedCandle } from '../../types'

function candle(time: number, high: number, low: number, volume: number, open = (high + low) / 2, close = open): UnifiedCandle {
  return { time, open, high, low, close, volume, symbol: 'BTCUSDT', exchange: 'binance-futures', timeframe: '5m' }
}

describe('detectPeaks', () => {
  it('finds local extrema with volume', () => {
    const candles = [
      candle(1, 10, 9, 1),
      candle(2, 12, 8, 5),
      candle(3, 11, 7, 1),
      candle(4, 11, 9, 1),
    ]
    const { h, l } = detectPeaks(candles)
    expect(h).toEqual([{ e: 12, t: 2, c: 5 }])
    expect(l).toEqual([{ e: 7, t: 3, c: 1 }])
  })

  it('ignores edges', () => {
    const candles = [candle(1, 40, 40, 1), candle(2, 50, 30, 1), candle(3, 30, 50, 1)]
    const { h, l } = detectPeaks(candles)
    expect(h).toEqual([{ e: 50, t: 2, c: 1 }])
    expect(l).toEqual([{ e: 30, t: 2, c: 1 }])
  })
})

describe('calcCascades (verbatim scalpboard port)', () => {
  const peak = (e: number, t: number, c = 1) => ({ e, t, c })

  it('chains peaks within maxDistance and drops short chains', () => {
    // 100, 100.3, 100.6 — 0.3% steps <= 0.4%; 102 breaks the chain
    const peaks = [peak(100, 1), peak(100.3, 2), peak(100.6, 3), peak(102, 4)]
    const out = calcCascades(peaks, 'h', 2, 0.4)
    expect(out.length).toBe(1)
    expect(out[0].map(p => p.e)).toEqual([100, 100.3, 100.6])
    expect(out[0][1].d).toBeCloseTo(0.3, 10)
  })

  it('requires minPeaks members', () => {
    const peaks = [peak(100, 1), peak(100.3, 2)]
    expect(calcCascades(peaks, 'h', 3, 0.4)).toEqual([])
    expect(calcCascades(peaks, 'h', 2, 0.4).length).toBe(1)
  })

  it('resumes the walk right after the breaker (which joins the next chain)', () => {
    // chain1: 100, 100.3, 100.6 | 102 breaks it | chain2: 102, 102.2, 102.4
    // (verbatim scalpboard port: the breaker re-anchors the next cascade)
    const peaks = [peak(100, 1), peak(100.3, 2), peak(100.6, 3), peak(102, 4), peak(102.2, 5), peak(102.4, 6)]
    const out = calcCascades(peaks, 'h', 2, 0.4)
    expect(out.length).toBe(2)
    expect(out[0].map(p => p.e)).toEqual([100, 100.3, 100.6])
    expect(out[1].map(p => p.e)).toEqual([102, 102.2, 102.4])
  })

  it('l side measures downward distance', () => {
    const peaks = [peak(100, 1), peak(99.7, 2), peak(99.4, 3)]
    const out = calcCascades(peaks, 'l', 2, 0.4)
    expect(out[0].map(p => p.e)).toEqual([100, 99.7, 99.4])
  })
})

describe('computeDensities', () => {
  it('spreads volume across price buckets and drops weak rows', () => {
    const candles = [
      candle(1, 100, 99, 100, 99, 100), // bullish -> b
      candle(2, 100, 99, 10, 100, 99),  // bearish -> a
    ]
    const rows = computeDensities(candles, 2)
    expect(rows.length).toBeGreaterThan(0)
    const bids = rows.filter(r => r.direction === 'b')
    const asks = rows.filter(r => r.direction === 'a')
    expect(bids.length).toBeGreaterThan(asks.length)
    // bearish share 10/span vs bullish 100/span: bullish rows dominate
    expect(bids[0].size).toBeGreaterThan(asks[0].size)
  })

  it('drops rows below the visibility threshold', () => {
    const candles = [candle(1, 100, 99, 1000, 99, 100)]
    const rows = computeDensities(candles, 2)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.size).toBeGreaterThan(0)
  })
})

describe('computeOverlays', () => {
  it('returns cascades and densities for a candle history', () => {
    const candles: UnifiedCandle[] = []
    for (let i = 0; i < 60; i++) {
      candles.push(candle(i + 1, 100 + i * 0.05, 99 + i * 0.05, 10))
    }
    const out = computeOverlays(candles, 2, 2, 0.4)
    expect(out.cascades).toBeDefined()
    expect(out.cascades.h).toBeInstanceOf(Array)
    expect(out.cascades.l).toBeInstanceOf(Array)
    expect(out.densities).toBeInstanceOf(Array)
    for (const d of out.densities) {
      expect(['a', 'b']).toContain(d.direction)
      expect(d.time).toBeGreaterThan(0)
    }
  })
})
