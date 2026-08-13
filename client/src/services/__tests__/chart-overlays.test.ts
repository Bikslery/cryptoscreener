import { describe, expect, it } from 'vitest'
import {
  detectPeaks, calcCascades, computeOverlays, computeCascades,
  DEFAULT_CASCADES_CONFIG,
} from '../chart-overlays'
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

  it('prominenceWindow filters single-candle wiggles around a wider floor', () => {
    // bar 3 is a local max vs direct neighbours (101 > 100, 100), but inside
    // a ±2 window the surrounding highs (105/104) make it a non-peak
    const candles = [
      candle(1, 105, 100, 10),
      candle(2, 100, 98, 10),
      candle(3, 101, 99, 10),
      candle(4, 100, 98, 10),
      candle(5, 104, 99, 10),
    ]
    const raw = detectPeaks(candles)
    expect(raw.h.map(p => p.e)).toContain(101)
    const filtered = detectPeaks(candles, { prominenceWindow: 2 })
    expect(filtered.h.map(p => p.e)).not.toContain(101)
  })

  it('minProminencePct drops weak extrema', () => {
    const candles = [
      candle(1, 100, 99, 10),
      candle(2, 100.05, 99, 10), // +0.05% vs neighbours — below 0.1% threshold
      candle(3, 100, 99, 10),
      candle(4, 100.5, 99, 10), // +0.5% standalone — passes
      candle(5, 100, 99, 10),
    ]
    const filtered = detectPeaks(candles, { minProminencePct: 0.1 })
    expect(filtered.h.map(p => p.e)).toEqual([100.5])
  })

  it('minVolumePct drops low-volume extrema', () => {
    const candles = [
      candle(1, 100, 99, 100),
      candle(2, 101, 99, 2),
      candle(3, 100, 99, 100),
    ]
    const filtered = detectPeaks(candles, { minVolumePct: 10 })
    expect(filtered.h).toEqual([])
    const allowed = detectPeaks(candles, { minVolumePct: 1 })
    expect(allowed.h.map(p => p.e)).toEqual([101])
  })

  it('lookback only considers recent candles', () => {
    const candles = [
      candle(1, 100, 99, 10),
      candle(2, 105, 99, 10),
      candle(3, 100, 99, 10),
      candle(4, 103, 99, 10),
      candle(5, 100, 99, 10),
    ]
    const all = detectPeaks(candles)
    expect(all.h.map(p => p.e)).toEqual([105, 103])
    const recent = detectPeaks(candles, { lookback: 2 })
    expect(recent.h.map(p => p.e)).toEqual([103])
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

describe('computeCascades — crossed levels disappear (scalpboard parity)', () => {
  // window=1, no noise filters: peaks are the raw local extrema
  const raw = { prominenceWindow: 1, minProminencePct: 0, minVolumePct: 0, maxChainLen: 0, maxCascades: 0, minPeaks: 2, maxDistance: 0.5 }

  // alternating H/L ladder: h-peaks at 100 / 100.3 / 100.6
  const ladder = (last: UnifiedCandle): UnifiedCandle[] => [
    candle(1, 99, 97, 10),
    candle(2, 100, 98, 10),
    candle(3, 99.5, 97.5, 10),
    candle(4, 100.3, 98.3, 10),
    candle(5, 99.6, 97.6, 10),
    candle(6, 100.6, 98.6, 10),
    candle(7, 100.2, 98.2, 10),
    last,
  ]

  it('keeps an h-ladder while no later candle closes through it', () => {
    // last candle closes at 99.85 — below every rung
    const out = computeCascades(ladder(candle(8, 100.2, 99.5, 10)), raw)
    expect(out.h.length).toBe(1)
    expect(out.h[0].map(p => p.e)).toEqual([100, 100.3, 100.6])
    expect(out.h[0].map(p => p.t)).toEqual([2, 4, 6])
    expect(out.h[0][1].d).toBeCloseTo(0.3, 8)
    expect(out.h[0][2].d).toBeCloseTo(0.2991, 3)
  })

  it('consumes the whole h-ladder once a later candle closes through it', () => {
    // last candle closes at 100.8 — above every rung
    const out = computeCascades(ladder(candle(8, 101, 100.3, 10, 100.4, 100.8)), raw)
    expect(out.h).toEqual([])
  })

  it('shrinks the ladder from the bottom when only the first rung is crossed', () => {
    const candles = [
      candle(1, 99, 97, 10),
      candle(2, 100, 98, 10),
      candle(3, 99.5, 97.5, 10),
      candle(4, 100.3, 98.3, 10),
      candle(5, 99.6, 97.6, 10),
      candle(6, 100.6, 98.6, 10),
      candle(7, 99.7, 97.7, 10),
      candle(8, 100.9, 98.9, 10),
      candle(9, 100.2, 98.2, 10),
      // closes above 100 (rung 1) but below 100.3 — the rest hold
      candle(10, 100.45, 98.45, 10, 100.2, 100.1),
    ]
    const out = computeCascades(candles, raw)
    expect(out.h.length).toBe(1)
    expect(out.h[0].map(p => p.e)).toEqual([100.3, 100.6, 100.9])
    expect(out.h[0].map(p => p.t)).toEqual([4, 6, 8])
    expect(out.h[0][1].d).toBeCloseTo(0.2991, 3)
    expect(out.h[0][2].d).toBeCloseTo(0.2982, 3)
  })

  it('consumes an l-ladder once a later candle closes through it', () => {
    // alternating H/L ladder: l-peaks at 98.5 / 98.2 / 97.9
    const ladder = [
      candle(1, 101, 99.2, 10),
      candle(2, 100.5, 98.5, 10),
      candle(3, 101.2, 98.8, 10),
      candle(4, 100.8, 98.2, 10),
      candle(5, 101.4, 98.5, 10),
      candle(6, 101, 97.9, 10),
      candle(7, 101.6, 98.2, 10),
      // closes at 96.8 — below every support rung
      candle(8, 100.5, 96.5, 10, 99, 96.8),
    ]
    const out = computeCascades(ladder, raw)
    expect(out.l).toEqual([])
  })

  it('keeps an l-ladder while no later candle closes through it', () => {
    const ladder = [
      candle(1, 101, 99.2, 10),
      candle(2, 100.5, 98.5, 10),
      candle(3, 101.2, 98.8, 10),
      candle(4, 100.8, 98.2, 10),
      candle(5, 101.4, 98.5, 10),
      candle(6, 101, 97.9, 10),
      candle(7, 101.6, 98.2, 10),
      candle(8, 100.8, 98.6, 10),
    ]
    const out = computeCascades(ladder, raw)
    expect(out.l.map(ch => ch.map(p => p.e))).toEqual([[98.5, 98.2, 97.9]])
  })
})

describe('computeOverlays', () => {
  const ladder = (): UnifiedCandle[] => {
    const candles: UnifiedCandle[] = []
    for (let i = 0; i < 60; i++) {
      candles.push(candle(i + 1, 100 + i * 0.05, 99 + i * 0.05, 10))
    }
    return candles
  }

  it('returns cascades and render options for a candle history', () => {
    const out = computeOverlays(ladder())
    expect(out.cascades).toBeDefined()
    expect(out.cascades.h).toBeInstanceOf(Array)
    expect(out.cascades.l).toBeInstanceOf(Array)
    expect(out.render).toEqual({
      showLabels: DEFAULT_CASCADES_CONFIG.showLabels,
      lineWidth: DEFAULT_CASCADES_CONFIG.lineWidth,
      opacity: DEFAULT_CASCADES_CONFIG.opacity,
    })
  })

  it('disables cascades via config', () => {
    const out = computeOverlays(ladder(), { showCascades: false })
    expect(out.cascades.h).toEqual([])
    expect(out.cascades.l).toEqual([])
  })

  it('caps cascade count and chain length via config', () => {
    const out = computeCascades(ladder(), { maxCascades: 2, maxChainLen: 2 })
    const all = [...out.h, ...out.l]
    expect(all.length).toBeLessThanOrEqual(2)
    for (const chain of all) expect(chain.length).toBeLessThanOrEqual(2)
  })

  it('defaults reduce noise for candle-derived peaks', () => {
    // A sine-ish series: raw peaks would chain everywhere; default filters
    // should visibly cut the level count vs the all-window=1 config.
    const candles: UnifiedCandle[] = []
    for (let i = 0; i < 200; i++) {
      const w = Math.sin(i / 7) * 0.4
      candles.push(candle(i + 1, 100 + w, 99.8 + w, 5 + (i % 3)))
    }
    const raw = computeCascades(candles, { prominenceWindow: 1, minProminencePct: 0, minVolumePct: 0, maxChainLen: 0, maxCascades: 0 })
    const filtered = computeCascades(candles)
    const rawCount = raw.h.length + raw.l.length
    const filteredCount = filtered.h.length + filtered.l.length
    expect(filteredCount).toBeLessThan(rawCount)
  })
})