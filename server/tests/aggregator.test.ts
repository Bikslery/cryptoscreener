import { describe, it, expect, vi } from 'vitest'
import type { UnifiedTicker } from '../src/types.js'

vi.mock('../src/ws/hub.js', () => ({
  broadcast: vi.fn(),
  broadcastToChannel: vi.fn(),
}))

vi.mock('../src/redis.js', () => ({
  getRedisPub: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(0) })),
  REDIS_ENABLED: false,
}))

vi.mock('../src/services/trades/aggTrade.js', () => ({
  subscribeAggTrade: vi.fn(),
  unsubscribeAggTrade: vi.fn(),
}))

import {
  parseExchangePriority,
  parseBlacklist,
  parseOverrides,
  pickBestTickers,
  computeTickerDelta,
} from '../src/services/aggregator/index.js'

function ticker(over: Partial<UnifiedTicker>): UnifiedTicker {
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    price: 50000,
    openPrice24h: 49000,
    change24h: 2.0408,
    high24h: 51000,
    low24h: 48000,
    volume24h: 1000,
    trades24h: 100,
    quoteVolume24h: 50000000,
    range1m: 0,
    natr5m: 0,
    corrBtc: null,
    tradesSpike: null,
    volumeSpike: null,
    pricePrecision: 2,
    timestamp: 1700000000000,
    ...over,
  }
}

describe('parseExchangePriority', () => {
  it('parses comma-separated exchange:priority pairs', () => {
    expect(parseExchangePriority('binance-futures:5,bybit-futures:4')).toEqual({
      'binance-futures': 5,
      'bybit-futures': 4,
    })
  })

  it('trims whitespace and ignores malformed pairs', () => {
    expect(parseExchangePriority(' binance-spot : 2 ,garbage,okx-spot:3')).toEqual({
      'binance-spot': 2,
      'okx-spot': 3,
    })
  })

  it('returns empty object for empty input', () => {
    expect(parseExchangePriority('')).toEqual({})
  })
})

describe('parseBlacklist', () => {
  it('parses exchange:comma,symbols segments', () => {
    const result = parseBlacklist('binance-spot:FOO,BAR;bybit-futures:BAZ')
    expect(Array.from(result.get('binance-spot')!)).toEqual(['FOO', 'BAR'])
    expect(Array.from(result.get('bybit-futures')!)).toEqual(['BAZ'])
  })

  it('filters empty symbols and ignores malformed segments', () => {
    const result = parseBlacklist('binance-spot:FOO,,BAR;garbage')
    expect(Array.from(result.get('binance-spot')!)).toEqual(['FOO', 'BAR'])
    expect(result.size).toBe(1)
  })
})

describe('parseOverrides', () => {
  it('parses nested JSON into Map<string, Map<string, number>>', () => {
    const result = parseOverrides('{"BTCUSDT":{"binance-futures":9,"bybit-futures":1}}')
    expect(result.get('BTCUSDT')!.get('binance-futures')).toBe(9)
    expect(result.get('BTCUSDT')!.get('bybit-futures')).toBe(1)
  })

  it('returns empty map on invalid JSON', () => {
    expect(parseOverrides('not json').size).toBe(0)
  })
})

describe('pickBestTickers', () => {
  const priority: Record<string, number> = {
    'binance-futures': 5,
    'bybit-futures': 4,
    'binance-spot': 2,
    'okx-spot': 3,
  }
  const isBlacklisted = () => false
  const getPriority = (ex: string) => priority[ex] ?? 0

  it('returns the highest-priority ticker per symbol', () => {
    const best = pickBestTickers([
      ticker({ exchange: 'binance-spot', price: 100 }),
      ticker({ exchange: 'binance-futures', price: 101 }),
      ticker({ exchange: 'bybit-futures', price: 102 }),
    ], { isBlacklisted, getPriority })
    expect(best.get('BTCUSDT')!.exchange).toBe('binance-futures')
  })

  it('keeps the first ticker when the symbol appears once', () => {
    const best = pickBestTickers([ticker({ exchange: 'bybit-futures' })], { isBlacklisted, getPriority })
    expect(best.get('BTCUSDT')!.exchange).toBe('bybit-futures')
  })

  it('excludes blacklisted tickers entirely', () => {
    const best = pickBestTickers([
      ticker({ exchange: 'binance-futures', price: 100 }),
      ticker({ exchange: 'bybit-futures', price: 101 }),
    ], {
      isBlacklisted: (ex) => ex === 'binance-futures',
      getPriority,
    })
    expect(best.get('BTCUSDT')!.exchange).toBe('bybit-futures')
  })

  it('honors per-symbol overrides over the default priority', () => {
    const overrides = new Map([['BTCUSDT', new Map([['bybit-futures', 10]])]])
    const getPriorityOverride = (ex: string, symbol?: string) =>
      (symbol && overrides.get(symbol)?.get(ex)) ?? priority[ex] ?? 0
    const best = pickBestTickers([
      ticker({ exchange: 'binance-futures', price: 100 }),
      ticker({ exchange: 'bybit-futures', price: 101 }),
    ], { isBlacklisted, getPriority: getPriorityOverride })
    expect(best.get('BTCUSDT')!.exchange).toBe('bybit-futures')
  })

  it('emits every symbol when symbols differ', () => {
    const best = pickBestTickers([
      ticker({ symbol: 'BTCUSDT' }),
      ticker({ symbol: 'ETHUSDT' }),
    ], { isBlacklisted, getPriority })
    expect(best.size).toBe(2)
  })
})

describe('computeTickerDelta', () => {
  it('emits all tickers on first run and returns next state', () => {
    const a = ticker({ price: 100 })
    const b = ticker({ symbol: 'ETHUSDT', price: 2000 })
    const { delta, next } = computeTickerDelta([a, b], new Map())
    expect(delta).toEqual([a, b])
    expect(next.size).toBe(2)
  })

  it('emits nothing when state is unchanged', () => {
    const a = ticker({ price: 100 })
    const { delta, next } = computeTickerDelta([a], new Map())
    const { delta: delta2 } = computeTickerDelta([a], next)
    expect(delta2).toEqual([])
  })

  it('emits a ticker whose price changed', () => {
    const { next } = computeTickerDelta([ticker({ price: 100 })], new Map())
    const changed = ticker({ price: 101 })
    const { delta } = computeTickerDelta([changed], next)
    expect(delta).toEqual([changed])
  })

  it('emits a ticker whose indicator changed', () => {
    const { next } = computeTickerDelta([ticker({ price: 100, volumeSpike: null })], new Map())
    const changed = ticker({ price: 100, volumeSpike: 2.5 })
    const { delta } = computeTickerDelta([changed], next)
    expect(delta).toEqual([changed])
  })

  it('emits a removal for tickers that disappeared from the array', () => {
    const a = ticker({ price: 100 })
    const { next } = computeTickerDelta([a], new Map())
    const { delta } = computeTickerDelta([], next)
    expect(delta.length).toBe(1)
    expect(delta[0].symbol).toBe('BTCUSDT')
  })

  it('tracks state independently of symbol order', () => {
    const a = ticker({ price: 100 })
    const b = ticker({ symbol: 'ETHUSDT', price: 2000 })
    const { next } = computeTickerDelta([a, b], new Map())
    const { delta } = computeTickerDelta([b, a], next)
    expect(delta).toEqual([])
  })
})