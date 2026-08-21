import { describe, it, expect, afterAll, vi } from 'vitest'
import zlib from 'zlib'

vi.mock('../src/middleware/auth.js', () => ({
  verifyTokenWithTelegram: vi.fn(async () => null),
}))

vi.mock('../src/redis.js', () => ({
  getRedisSub: vi.fn(() => ({ on: vi.fn() })),
  REDIS_ENABLED: false,
}))

vi.mock('../src/services/aggregator/index.js', () => ({
  getAllTickers: vi.fn(() => []),
  getTickers: vi.fn(() => []),
  getTicker: vi.fn(() => undefined),
  setTickersFromRedis: vi.fn(),
}))

vi.mock('../src/services/candles/candle-cache.js', () => ({
  getTopCachedSymbols: vi.fn(() => []),
  getCachedCandles: vi.fn(() => []),
  updateCachedCandle: vi.fn(),
}))

vi.mock('../src/services/candles/preload.js', () => ({
  INITIAL_CANDLES_TF: '5m',
}))

vi.mock('../src/services/trades/aggTrade.js', () => ({}))

import { encodePayload, classifyChannel, makeChannelMessage, stopWsHub, shouldRelayAlert } from '../src/ws/hub.js'

afterAll(() => {
  stopWsHub()
})

describe('encodePayload', () => {
  it('returns a plain JSON string for small frames (no deflate overhead)', () => {
    const payload = { type: 'price', channel: 'price:BTCUSDT', data: { price: 50000 } }
    const encoded = encodePayload(payload)
    expect(typeof encoded).toBe('string')
    expect(JSON.parse(encoded as string)).toEqual(payload)
  })

  it('deflate-raw compresses frames above the 4096-byte threshold', () => {
    const data = {
      type: 'ticker',
      data: Array.from({ length: 400 }, (_, i) => ({
        symbol: `SYM${String(i).padStart(4, '0')}USDT`,
        exchange: 'binance-futures',
        price: 1000 + i,
        change24h: 1.23,
        quoteVolume24h: 12345678,
        corrBtc: 0.5,
        tradesSpike: null,
        volumeSpike: 2.5,
      })),
    }
    const encoded = encodePayload(data)
    expect(Buffer.isBuffer(encoded)).toBe(true)
    const inflated = zlib.inflateRawSync(encoded as Buffer).toString('utf8')
    expect(JSON.parse(inflated)).toEqual(data)
  })

  it('round-trips the exact threshold boundary correctly', () => {
    const baseLen = JSON.stringify({ type: 'x', data: '' }).length
    const small = { type: 'x', data: 'a'.repeat(4096 - baseLen) } // exactly 4096 bytes
    expect(typeof encodePayload(small)).toBe('string')
    const big = { type: 'x', data: 'a'.repeat(4096 - baseLen + 1) } // 4097 bytes
    expect(Buffer.isBuffer(encodePayload(big))).toBe(true)
  })
})

describe('classifyChannel', () => {
  it('maps channel prefixes to their drop-diag lanes', () => {
    expect(classifyChannel('candle:binance-futures:BTCUSDT:1m')).toBe('candle')
    expect(classifyChannel('trade:binance-futures:BTCUSDT')).toBe('trade')
    expect(classifyChannel('price:BTCUSDT')).toBe('price')
    expect(classifyChannel('ticker')).toBe('ticker')
    expect(classifyChannel('ticker:BTCUSDT')).toBe('ticker')
  })

  it('falls back to the other lane for unrecognized channels', () => {
    expect(classifyChannel('depth:BTCUSDT')).toBe('other')
    expect(classifyChannel('density')).toBe('other')
  })
})

describe('makeChannelMessage', () => {
  it('stamps channel frames with server send time for browser latency measurement', () => {
    expect(makeChannelMessage('trade:binance-futures:BTCUSDT', { price: 50000 }, 1234)).toEqual({
      type: 'trade:binance-futures:BTCUSDT',
      channel: 'trade:binance-futures:BTCUSDT',
      data: { price: 50000 },
      ts: 1234,
    })
  })
})

describe('shouldRelayAlert — Redis alert-relay dedup', () => {
  it('passes the first delivery of an alert id', () => {
    expect(shouldRelayAlert('al-dedup-1')).toBe(true)
  })

  it('drops a re-delivery of the same id within the window (double-broadcast guard)', () => {
    expect(shouldRelayAlert('al-dedup-2')).toBe(true)
    expect(shouldRelayAlert('al-dedup-2')).toBe(false)
  })

  it('passes alerts without an id (nothing to dedupe on)', () => {
    expect(shouldRelayAlert(undefined)).toBe(true)
    expect(shouldRelayAlert(null)).toBe(true)
    expect(shouldRelayAlert('')).toBe(true)
  })
})
