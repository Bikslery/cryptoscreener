import { beforeEach, describe, expect, it, vi } from 'vitest'

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    scan: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('../src/redis.js', () => ({
  REDIS_ENABLED: true,
  getRedisData: vi.fn(() => redisMock),
}))

vi.mock('../src/services/aggregator/index.js', () => ({
  fetchCandles: vi.fn(),
  fetchCandlesSeamless: vi.fn(),
  getTicker: vi.fn(() => undefined),
}))

vi.mock('../src/services/exchanges/proxy.js', () => ({
  pickDispatcher: vi.fn(() => ({ dispatcher: undefined, ipIndex: 0 })),
  addWeightToIp: vi.fn(),
  getIpCount: vi.fn(() => 1),
}))

vi.mock('../src/services/exchanges/rate-limiter.js', () => ({
  acquireBudget: vi.fn(async () => true),
}))

import { decodeHistoryChunk, flushHistoryChunkCache } from '../src/services/candles/history.js'

describe('history cache startup migration', () => {
  beforeEach(() => {
    redisMock.scan.mockReset()
    redisMock.del.mockReset()
  })

  it('keeps active versioned chunks regardless of their market timestamp', async () => {
    const oldMarketTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000
    const activeKey = `hist:v2:binance-futures:BTCUSDT:1h:${oldMarketTimestamp}`
    redisMock.scan.mockResolvedValue(['0', [activeKey]])

    await flushHistoryChunkCache()

    expect(redisMock.del).not.toHaveBeenCalled()
  })

  it('decodes the versioned envelope while waiting for another process lock', () => {
    const raw = JSON.stringify({
      version: 2,
      writtenAt: 1700000000000,
      complete: false,
      rowCount: 1,
      minTime: 1700000000,
      maxTime: 1700000000,
      sources: ['binance-futures'],
      rows: [[1700000000, 100, 101, 99, 100.5, 10]],
    })

    expect(decodeHistoryChunk(raw, 'BTCUSDT', 'binance-futures', '1m')).toEqual([{
      symbol: 'BTCUSDT',
      exchange: 'binance-futures',
      timeframe: '1m',
      time: 1700000000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 10,
    }])
  })
})
