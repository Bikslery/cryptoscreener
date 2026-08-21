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
    expect(bybit.parseTicker({ symbol: 'NEVERSEENUSDT' })).toBeNull()
  })

  it('merges ticker deltas with the previous snapshot', () => {
    bybit.parseTicker({
      symbol: 'ETHUSDT', lastPrice: '2000', prevPrice24h: '1900', highPrice24h: '2100',
      lowPrice24h: '1800', volume24h: '500', turnover24h: '1000000',
    })

    const updated = bybit.parseTicker({ symbol: 'ETHUSDT', lastPrice: '2050' })

    expect(updated!.price).toBe(2050)
    expect(updated!.openPrice24h).toBe(1900)
    expect(updated!.high24h).toBe(2100)
    expect(updated!.volume24h).toBe(500)
  })
})

describe('BybitFuturesAdapter.parseTrades', () => {
  const bybit = new BybitFuturesAdapter()

  it('normalizes publicTrade rows with millisecond event time and maker side', () => {
    const trades = bybit.parseTrades([
      { s: 'BTCUSDT', p: '50123.5', v: '0.25', T: 1700000000123, S: 'Sell', i: 'trade-1', seq: '77' },
    ], 'publicTrade.BTCUSDT')

    expect(trades).toEqual([{
      symbol: 'BTCUSDT',
      exchange: 'bybit-futures',
      price: 50123.5,
      volume: 0.25,
      eventTimeMs: 1700000000123,
      isBuyerMaker: true,
      tradeId: 'trade-1',
      sequence: '77',
    }])
  })

  it('drops malformed publicTrade rows', () => {
    expect(bybit.parseTrades([{ s: 'BTCUSDT', p: 'bad', v: '1', T: 1 }], 'publicTrade.BTCUSDT')).toEqual([])
  })
})

describe('BybitFuturesAdapter trade subscription refcount', () => {
  it('keeps the trade topic while another timeframe still uses the symbol', () => {
    const bybit = new BybitFuturesAdapter()
    bybit.subscribeTrade('BTCUSDT')
    bybit.subscribeTrade('BTCUSDT')
    expect(bybit.getTradeSubscriptionRefCount('BTCUSDT')).toBe(2)

    bybit.unsubscribeTrade('BTCUSDT')
    expect(bybit.getTradeSubscriptionRefCount('BTCUSDT')).toBe(1)
    bybit.unsubscribeTrade('BTCUSDT')
    expect(bybit.getTradeSubscriptionRefCount('BTCUSDT')).toBe(0)
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
