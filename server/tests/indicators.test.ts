import { describe, it, expect } from 'vitest'
import {
  pearson,
  computeVolumeSpike,
  TradeBucketTracker,
  applyIndicator,
  BUCKET_MS,
  MAX_BUCKETS,
  MIN_BUCKETS,
} from '../src/services/aggregator/indicators.js'
import type { UnifiedCandle, UnifiedTicker } from '../src/types.js'

function candle(time: number, volume: number): UnifiedCandle {
  return {
    symbol: 'TESTUSDT',
    exchange: 'binance-futures',
    timeframe: '5m',
    time,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume,
  }
}

describe('pearson', () => {
  it('returns 1 for perfectly correlated series', () => {
    expect(pearson([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 10)
  })

  it('returns -1 for perfectly anti-correlated series', () => {
    expect(pearson([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10)
  })

  it('returns null when a series has zero variance', () => {
    expect(pearson([5, 5, 5], [1, 2, 3])).toBeNull()
  })

  it('returns null for fewer than two pairs', () => {
    expect(pearson([1], [1])).toBeNull()
    expect(pearson([], [])).toBeNull()
  })

  it('truncates to the shorter series length', () => {
    const r = pearson([1, 2, 3], [2, 4, 6, 100, 200])
    expect(r).not.toBeNull()
    expect(r!).toBeCloseTo(1, 10)
  })
})

describe('computeVolumeSpike', () => {
  it('computes forming candle volume over the 30-candle baseline average', () => {
    const candles = Array.from({ length: MAX_BUCKETS }, (_, i) => candle(i * BUCKET_MS / 1000, 100))
    candles.push(candle(MAX_BUCKETS * BUCKET_MS / 1000, 300))
    expect(computeVolumeSpike(candles)).toBeCloseTo(3, 10)
  })

  it('returns null when the window is too short', () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100))
    expect(computeVolumeSpike(candles)).toBeNull()
  })

  it('returns null when the baseline average is zero', () => {
    const candles = Array.from({ length: MAX_BUCKETS + 1 }, (_, i) => candle(i, 0))
    expect(computeVolumeSpike(candles)).toBeNull()
  })
})

describe('TradeBucketTracker', () => {
  const t0 = 1_700_000_000_000 // arbitrary ms aligned start

  it('ignores the forming bucket — spikes use completed buckets only', () => {
    const tracker = new TradeBucketTracker()
    for (let i = 0; i < 200; i++) tracker.recordTrade('TESTUSDT', t0 + i * 1000)
    expect(tracker.getSpike('TESTUSDT')).toBeNull()
  })

  it('returns null until MIN_BUCKETS completed buckets exist', () => {
    const tracker = new TradeBucketTracker()
    for (let b = 0; b < MIN_BUCKETS - 1; b++) {
      for (let i = 0; i < 10; i++) tracker.recordTrade('TESTUSDT', t0 + b * BUCKET_MS + i * 1000)
    }
    expect(tracker.getSpike('TESTUSDT')).toBeNull()
  })

  it('computes spike = last completed / average of previous buckets', () => {
    const tracker = new TradeBucketTracker()
    // 4 baseline buckets of 10 trades, then a spike bucket of 30; one more
    // trade rolls the spike bucket into the completed window.
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 10; i++) tracker.recordTrade('TESTUSDT', t0 + b * BUCKET_MS + i * 1000)
    }
    for (let i = 0; i < 30; i++) tracker.recordTrade('TESTUSDT', t0 + 4 * BUCKET_MS + i * 1000)
    tracker.recordTrade('TESTUSDT', t0 + 5 * BUCKET_MS)
    const spike = tracker.getSpike('TESTUSDT')
    expect(spike).not.toBeNull()
    expect(spike!).toBeCloseTo(3, 10)
  })

  it('reports the new spike exactly once when a bucket rolls over', () => {
    const tracker = new TradeBucketTracker()
    let reported = 0
    let lastReported: number | null = null
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 10; i++) {
        const res = tracker.recordTrade('TESTUSDT', t0 + b * BUCKET_MS + i * 1000)
        if (res) {
          reported++
          lastReported = res.spike
        }
      }
    }
    // Spike bucket: 50 trades (bucket 4), then the first trade of bucket 5
    // completes bucket 4 and fires the single report.
    for (let i = 0; i < 50; i++) {
      const res = tracker.recordTrade('TESTUSDT', t0 + 4 * BUCKET_MS + i * 1000)
      if (res) {
        reported++
        lastReported = res.spike
      }
    }
    const res = tracker.recordTrade('TESTUSDT', t0 + 5 * BUCKET_MS)
    if (res) {
      reported++
      lastReported = res.spike
    }
    expect(reported).toBe(1)
    expect(lastReported).toBeCloseTo(5, 10)
  })

  it('trims the completed window to MAX_BUCKETS', () => {
    const tracker = new TradeBucketTracker()
    for (let b = 0; b < MAX_BUCKETS + 5; b++) {
      for (let i = 0; i < 10; i++) tracker.recordTrade('TESTUSDT', t0 + b * BUCKET_MS + i * 1000)
    }
    const spike = tracker.getSpike('TESTUSDT')
    expect(spike).not.toBeNull()
    expect(spike!).toBeCloseTo(1, 10)
  })
})

describe('applyIndicator', () => {
  function ticker(symbol: string, exchange: UnifiedTicker['exchange']): UnifiedTicker {
    return {
      symbol,
      exchange,
      price: 1,
      change24h: 0,
      high24h: 1,
      low24h: 1,
      volume24h: 0,
      trades24h: 0,
      quoteVolume24h: 0,
      range1m: 0,
      natr5m: 0,
      corrBtc: null,
      tradesSpike: null,
      volumeSpike: null,
      pricePrecision: 2,
      timestamp: 0,
    }
  }

  it('writes to every exchange entry of the symbol', () => {
    const map = new Map<string, UnifiedTicker>()
    const futures = ticker('TESTUSDT', 'binance-futures')
    const bybit = ticker('TESTUSDT', 'bybit-futures')
    map.set('TESTUSDT:binance-futures', futures)
    map.set('TESTUSDT:bybit-futures', bybit)
    applyIndicator(map, 'TESTUSDT', { corrBtc: 0.42 })
    expect(futures.corrBtc).toBe(0.42)
    expect(bybit.corrBtc).toBe(0.42)
  })

  it('respects the exchange filter', () => {
    const map = new Map<string, UnifiedTicker>()
    const futures = ticker('TESTUSDT', 'binance-futures')
    const bybit = ticker('TESTUSDT', 'bybit-futures')
    map.set('TESTUSDT:binance-futures', futures)
    map.set('TESTUSDT:bybit-futures', bybit)
    applyIndicator(map, 'TESTUSDT', { tradesSpike: 2.5 }, new Set(['binance-futures']))
    expect(futures.tradesSpike).toBe(2.5)
    expect(bybit.tradesSpike).toBeNull()
  })

  it('does not touch other symbols', () => {
    const map = new Map<string, UnifiedTicker>()
    const other = ticker('OTHERUSDT', 'binance-futures')
    map.set('OTHERUSDT:binance-futures', other)
    applyIndicator(map, 'TESTUSDT', { corrBtc: 0.5 })
    expect(other.corrBtc).toBeNull()
  })
})
