import { describe, it, expect } from 'vitest'
import {
  pickExchangeTicker,
  lastCandleIndex,
  matchesImpulseCandle,
  normalizeImpulseCondition,
  DEFAULT_IMPULSE_EXCHANGES,
} from '../src/services/alerts/impulse.js'
import { validateImpulseCondition, validatePriceCondition, validateListingCondition } from '../src/services/alerts/validate.js'
import type { ImpulseAlertCondition, UnifiedCandle, UnifiedTicker } from '../src/types.js'

function ticker(symbol: string, exchange: UnifiedTicker['exchange'], quoteVolume24h: number): UnifiedTicker {
  return {
    symbol,
    exchange,
    price: 1,
    change24h: 0,
    high24h: 1,
    low24h: 1,
    volume24h: 0,
    trades24h: 0,
    quoteVolume24h,
    range1m: 0,
    natr5m: 0,
    corrBtc: null,
    tradesSpike: null,
    volumeSpike: null,
    pricePrecision: 2,
    timestamp: 0,
  }
}

function candle(time: number, open: number, high: number, low: number, close: number, volume: number, isFinal = true): UnifiedCandle {
  return { symbol: 'TESTUSDT', exchange: 'binance-futures', timeframe: '5m', time, open, high, low, close, volume, isFinal }
}

function cond(overrides: Partial<ImpulseAlertCondition> = {}): ImpulseAlertCondition {
  return {
    percent: 2,
    timeframe: '5m',
    direction: 'both',
    volumeSpike: 0,
    exchanges: [{ exchange: 'binance-futures', minVolume24h: 0 }],
    ...overrides,
  }
}

describe('pickExchangeTicker', () => {
  it('picks the first exchange in priority order that satisfies minVolume24h', () => {
    const bySymbol = new Map<string, Map<string, UnifiedTicker>>()
    const m = new Map<string, UnifiedTicker>()
    m.set('binance-futures', ticker('TESTUSDT', 'binance-futures', 500))
    m.set('binance-spot', ticker('TESTUSDT', 'binance-spot', 100_000))
    bySymbol.set('TESTUSDT', m)

    const t = pickExchangeTicker(bySymbol, 'TESTUSDT', [
      { exchange: 'binance-futures', minVolume24h: 0 },
      { exchange: 'binance-spot', minVolume24h: 0 },
    ])
    expect(t?.exchange).toBe('binance-futures')
  })

  it('skips an exchange below its minVolume24h and falls through to the next', () => {
    const bySymbol = new Map<string, Map<string, UnifiedTicker>>()
    const m = new Map<string, UnifiedTicker>()
    m.set('binance-futures', ticker('TESTUSDT', 'binance-futures', 500))
    m.set('binance-spot', ticker('TESTUSDT', 'binance-spot', 100_000))
    bySymbol.set('TESTUSDT', m)

    const t = pickExchangeTicker(bySymbol, 'TESTUSDT', [
      { exchange: 'binance-futures', minVolume24h: 10_000 },
      { exchange: 'binance-spot', minVolume24h: 0 },
    ])
    expect(t?.exchange).toBe('binance-spot')
  })

  it('returns null when no exchange qualifies', () => {
    const bySymbol = new Map<string, Map<string, UnifiedTicker>>()
    const m = new Map<string, UnifiedTicker>()
    m.set('binance-futures', ticker('TESTUSDT', 'binance-futures', 500))
    bySymbol.set('TESTUSDT', m)

    expect(pickExchangeTicker(bySymbol, 'TESTUSDT', [{ exchange: 'binance-futures', minVolume24h: 10_000 }])).toBeNull()
    expect(pickExchangeTicker(bySymbol, 'MISSINGUSDT', [{ exchange: 'binance-futures', minVolume24h: 0 }])).toBeNull()
  })
})

describe('lastCandleIndex', () => {
  it('always returns the last candle — forming candles are eligible', () => {
    const candles = [
      candle(1, 1, 1, 1, 1, 1),
      candle(2, 1, 1, 1, 1, 1),
      candle(3, 1, 1, 1, 1, 1, false),
    ]
    expect(lastCandleIndex(candles)).toBe(2)
  })

  it('returns the last index for closed-only series too', () => {
    const candles = [candle(1, 1, 1, 1, 1, 1), candle(2, 1, 1, 1, 1, 1)]
    expect(lastCandleIndex(candles)).toBe(1)
  })
})

describe('matchesImpulseCandle', () => {
  it('requires the range move to reach percent', () => {
    const c = candle(10, 100, 103, 100, 102, 1) // 3% range
    expect(matchesImpulseCandle(cond({ percent: 3, direction: 'both' }), c, [])).toBe(true)
    expect(matchesImpulseCandle(cond({ percent: 3.1, direction: 'both' }), c, [])).toBe(false)
  })

  it('filters by direction (close vs open)', () => {
    const up = candle(10, 100, 104, 100, 103, 1)
    const down = candle(10, 100, 104, 96, 97, 1)
    expect(matchesImpulseCandle(cond({ percent: 2, direction: 'up' }), up, [])).toBe(true)
    expect(matchesImpulseCandle(cond({ percent: 2, direction: 'up' }), down, [])).toBe(false)
    expect(matchesImpulseCandle(cond({ percent: 2, direction: 'down' }), down, [])).toBe(true)
    expect(matchesImpulseCandle(cond({ percent: 2, direction: 'down' }), up, [])).toBe(false)
    expect(matchesImpulseCandle(cond({ percent: 2, direction: 'both' }), up, [])).toBe(true)
    expect(matchesImpulseCandle(cond({ percent: 2, direction: 'both' }), down, [])).toBe(true)
  })

  it('enforces the volume spike vs the 30-candle baseline', () => {
    const baseline = Array.from({ length: 30 }, (_, i) => candle(i, 1, 1, 1, 1, 100))
    const big = candle(40, 100, 104, 100, 102, 250)
    expect(matchesImpulseCandle(cond({ percent: 2, volumeSpike: 2 }), big, baseline)).toBe(true)
    expect(matchesImpulseCandle(cond({ percent: 2, volumeSpike: 3 }), big, baseline)).toBe(false)
  })

  it('matches a forming candle the same way as a closed one', () => {
    const forming = candle(10, 100, 104, 100, 102, 1, false)
    expect(matchesImpulseCandle(cond({ percent: 2, direction: 'both' }), forming, [])).toBe(true)
  })

  it('fails the spike when the baseline is shorter than 30 candles', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => candle(i, 1, 1, 1, 1, 100))
    const big = candle(40, 100, 104, 100, 102, 250)
    expect(matchesImpulseCandle(cond({ percent: 2, volumeSpike: 2 }), big, baseline)).toBe(false)
  })
})

describe('normalizeImpulseCondition', () => {
  it('fills defaults for legacy {percent, within} rows so they keep firing', () => {
    const legacy = { percent: 5, within: '5m' } as unknown as ImpulseAlertCondition
    const n = normalizeImpulseCondition(legacy)
    expect(n.percent).toBe(5)
    expect(n.timeframe).toBe('5m')
    expect(n.direction).toBe('both')
    expect(n.volumeSpike).toBe(0)
    expect(n.exchanges).toEqual(DEFAULT_IMPULSE_EXCHANGES)
  })

  it('passes valid conditions through unchanged', () => {
    const c = cond({ percent: 3, direction: 'down', volumeSpike: 2 })
    expect(normalizeImpulseCondition(c)).toEqual(c)
  })

  it('preserves lastFiredCandleTime', () => {
    const c = cond({ lastFiredCandleTime: 123 })
    expect(normalizeImpulseCondition(c).lastFiredCandleTime).toBe(123)
  })
})

describe('validateImpulseCondition', () => {
  const valid = {
    percent: 3,
    timeframe: '5m',
    direction: 'down',
    volumeSpike: 2,
    exchanges: [
      { exchange: 'binance-futures', minVolume24h: 0 },
      { exchange: 'bybit-futures', minVolume24h: 100000 },
    ],
  }

  it('accepts a valid condition and drops engine bookkeeping', () => {
    const res = validateImpulseCondition({ ...valid, lastFiredCandleTime: 999 })
    expect('condition' in res).toBe(true)
    if ('condition' in res) {
      expect(res.condition.percent).toBe(3)
      expect(res.condition.lastFiredCandleTime).toBeUndefined()
    }
  })

  it('dedupes repeated exchanges keeping the first occurrence', () => {
    const res = validateImpulseCondition({
      ...valid,
      exchanges: [
        { exchange: 'binance-futures', minVolume24h: 5 },
        { exchange: 'binance-futures', minVolume24h: 9 },
      ],
    })
    if ('condition' in res) {
      expect(res.condition.exchanges).toEqual([{ exchange: 'binance-futures', minVolume24h: 5 }])
    } else {
      expect.unreachable()
    }
  })

  it.each([
    [{ ...valid, percent: -1 }, 'percent'],
    [{ ...valid, timeframe: '15m' }, 'timeframe'],
    [{ ...valid, direction: 'sideways' }, 'direction'],
    [{ ...valid, volumeSpike: -0.5 }, 'volumeSpike'],
    [{ ...valid, exchanges: [] }, 'exchanges'],
    [{ ...valid, exchanges: [{ exchange: 'kraken', minVolume24h: 0 }] }, 'exchanges'],
    [{ ...valid, exchanges: [{ exchange: 'binance-spot', minVolume24h: -1 }] }, 'exchanges'],
  ])('rejects %o', (bad) => {
    expect('error' in validateImpulseCondition(bad)).toBe(true)
  })
})

describe('validatePriceCondition', () => {
  it('accepts a valid condition', () => {
    expect('condition' in validatePriceCondition({ price: 100, direction: 'above' })).toBe(true)
  })

  it('rejects garbage', () => {
    expect('error' in validatePriceCondition({ price: -1, direction: 'above' })).toBe(true)
    expect('error' in validatePriceCondition({ price: 100, direction: 'sideways' })).toBe(true)
    expect('error' in validatePriceCondition('nope')).toBe(true)
  })
})

describe('validateListingCondition', () => {
  it('accepts a valid exchange and rejects unknown ones', () => {
    expect('condition' in validateListingCondition({ exchange: 'binance-futures' })).toBe(true)
    expect('error' in validateListingCondition({ exchange: 'kraken' })).toBe(true)
  })
})
