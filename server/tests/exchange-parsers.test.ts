import { describe, it, expect } from 'vitest'
import { BinanceSpotAdapter } from '../src/services/exchanges/binance-spot.js'
import { BinanceFuturesAdapter } from '../src/services/exchanges/binance-futures.js'
import { BybitFuturesAdapter } from '../src/services/exchanges/bybit-futures.js'

describe('BinanceSpotAdapter.parseTicker', () => {
  const spot = new BinanceSpotAdapter()

  it('parses the WS miniTicker format', () => {
    const t = spot.parseTicker({ s: 'BTCUSDT', c: '50000', o: '49000', h: '51000', l: '48000', v: '1000', n: 12345, q: '50000000' })
    expect(t.symbol).toBe('BTCUSDT')
    expect(t.exchange).toBe('binance-spot')
    expect(t.price).toBe(50000)
    expect(t.openPrice24h).toBe(49000)
    expect(t.change24h).toBeCloseTo((50000 - 49000) / 49000 * 100, 5)
    expect(t.high24h).toBe(51000)
    expect(t.low24h).toBe(48000)
    expect(t.volume24h).toBe(1000)
    expect(t.trades24h).toBe(12345)
    expect(t.quoteVolume24h).toBe(50000000)
  })

  it('parses the REST 24hr ticker format', () => {
    const t = spot.parseTicker({
      symbol: 'ETHUSDT', lastPrice: '2000', openPrice: '1900', highPrice: '2100',
      lowPrice: '1850', volume: '500', count: 999, quoteVolume: '1000000',
    })
    expect(t.symbol).toBe('ETHUSDT')
    expect(t.price).toBe(2000)
    expect(t.trades24h).toBe(999)
  })
})

describe('BinanceSpotAdapter.parseCandle', () => {
  const spot = new BinanceSpotAdapter()

  it('parses the kline payload inside a wrapped message', () => {
    const c = spot.parseCandle({
      k: { s: 'BTCUSDT', i: '1m', t: 1700000000000, o: '49000', h: '50000', l: '48000', c: '49500', v: '100', x: false },
    })
    expect(c!.symbol).toBe('BTCUSDT')
    expect(c!.exchange).toBe('binance-spot')
    expect(c!.timeframe).toBe('1m')
    expect(c!.time).toBe(1700000000)
    expect(c!.open).toBe(49000)
    expect(c!.close).toBe(49500)
    expect(c!.isFinal).toBe(false)
  })

  it('parses the kline payload under msg.data', () => {
    const c = spot.parseCandle({ data: { k: { s: 'ETHUSDT', i: '5m', t: 1700000300000, o: '1', h: '2', l: '1', c: '1.5', v: '10', x: true } } })
    expect(c!.symbol).toBe('ETHUSDT')
    expect(c!.timeframe).toBe('5m')
    expect(c!.isFinal).toBe(true)
  })

  it('returns null when no kline is present', () => {
    expect(spot.parseCandle({ foo: 'bar' })).toBeNull()
  })
})

describe('BinanceFuturesAdapter.parseTicker', () => {
  const fut = new BinanceFuturesAdapter()

  it('parses the WS miniTicker format with futures exchange label', () => {
    const t = fut.parseTicker({ s: 'BTCUSDT', c: '50000', o: '49000', h: '51000', l: '48000', v: '1000', n: 5, q: '50000000' })
    expect(t.symbol).toBe('BTCUSDT')
    expect(t.exchange).toBe('binance-futures')
    expect(t.price).toBe(50000)
  })
})

describe('BinanceFuturesAdapter.parseCandle', () => {
  const fut = new BinanceFuturesAdapter()

  it('parses the kline payload', () => {
    const c = fut.parseCandle({ k: { s: 'BTCUSDT', i: '1h', t: 1700000000000, o: '49000', h: '50000', l: '48000', c: '49500', v: '100', x: true } })
    expect(c!.symbol).toBe('BTCUSDT')
    expect(c!.exchange).toBe('binance-futures')
    expect(c!.timeframe).toBe('1h')
    expect(c!.time).toBe(1700000000)
    expect(c!.isFinal).toBe(true)
  })

  it('returns null when no kline is present', () => {
    expect(fut.parseCandle({})).toBeNull()
  })
})

describe('BybitFuturesAdapter.parseTicker', () => {
  const bybit = new BybitFuturesAdapter()

  it('parses the ticker push format', () => {
    const t = bybit.parseTicker({
      symbol: 'BTCUSDT', lastPrice: '50000', prevPrice24h: '49000', highPrice24h: '51000',
      lowPrice24h: '48000', volume24h: '1000', turnover24h: '50000000',
    })
    expect(t!.symbol).toBe('BTCUSDT')
    expect(t!.exchange).toBe('bybit-futures')
    expect(t!.price).toBe(50000)
    expect(t!.openPrice24h).toBe(49000)
    expect(t!.quoteVolume24h).toBe(50000000)
  })

  it('rejects deltas that omit lastPrice (would serialize to null price)', () => {
    expect(bybit.parseTicker({ symbol: 'BTCUSDT' })).toBeNull()
  })
})

describe('BybitFuturesAdapter.parseCandle', () => {
  const bybit = new BybitFuturesAdapter()

  it('derives timeframe and symbol from the topic', () => {
    const c = bybit.parseCandle(
      { start: 1700000000000, open: '49000', high: '50000', low: '48000', close: '49500', volume: '100', confirm: false, symbol: 'BTCUSDT' },
      'kline.5.BTCUSDT',
    )
    expect(c!.symbol).toBe('BTCUSDT')
    expect(c!.exchange).toBe('bybit-futures')
    expect(c!.timeframe).toBe('5m')
    expect(c!.time).toBe(1700000000)
    expect(c!.isFinal).toBe(false)
  })

  it('returns null for missing data', () => {
    expect(bybit.parseCandle(null, 'kline.5.BTCUSDT')).toBeNull()
  })
})

describe('BybitFuturesAdapter.parseDepth', () => {
  const bybit = new BybitFuturesAdapter()

  it('parses orderbook snapshot levels into numeric tuples', () => {
    const d = bybit.parseDepth({ s: 'BTCUSDT', b: [['49999', '1.2']], a: [['50001', '0.8']] }, 'orderbook.200.BTCUSDT')
    expect(d!.symbol).toBe('BTCUSDT')
    expect(d!.exchange).toBe('bybit-futures')
    expect(d!.bids).toEqual([[49999, 1.2]])
    expect(d!.asks).toEqual([[50001, 0.8]])
  })

  it('returns null when bids or asks are missing', () => {
    expect(bybit.parseDepth({ s: 'BTCUSDT', b: [] }, 'orderbook.200.BTCUSDT')).toBeNull()
  })
})