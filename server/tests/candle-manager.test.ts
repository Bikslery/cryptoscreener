import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { UnifiedCandle } from '../src/types.js'

const { publishMock } = vi.hoisted(() => ({
  publishMock: vi.fn().mockResolvedValue(0),
}))

vi.mock('../src/ws/hub.js', () => ({
  broadcastToChannel: vi.fn(),
}))

vi.mock('../src/redis.js', () => ({
  getRedisPub: vi.fn(() => ({ publish: publishMock })),
  REDIS_ENABLED: true,
}))

vi.mock('../src/services/aggregator/index.js', () => ({
  getTicker: vi.fn(() => undefined),
}))

vi.mock('../src/services/trades/aggTrade.js', () => ({
  subscribeAggTrade: vi.fn(),
  unsubscribeAggTrade: vi.fn(),
}))

vi.mock('../src/services/candles/repair.js', () => ({
  repairCacheWindow: vi.fn().mockResolvedValue(null),
}))

import {
  recordInboundCandle,
  __test,
  createRemoteCandleManager,
  getCandleDiagStats,
} from '../src/services/candles/manager.js'

function candle(time: number, over: Partial<UnifiedCandle> = {}): UnifiedCandle {
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    timeframe: '1m',
    time,
    open: 49000,
    high: 50000,
    low: 48000,
    close: 49500,
    volume: 100,
    ...over,
  }
}

describe('recordInboundCandle', () => {
  beforeEach(() => {
    __test.resetCandleDiag()
  })

  it('returns null for the first candle of a series', () => {
    expect(recordInboundCandle(candle(1700000000))).toBeNull()
  })

  it('returns null for a normal contiguous next period', () => {
    recordInboundCandle(candle(1700000000))
    expect(recordInboundCandle(candle(1700000060))).toBeNull()
  })

  it('returns null for a repeat update of the same period', () => {
    recordInboundCandle(candle(1700000000))
    expect(recordInboundCandle(candle(1700000000))).toBeNull()
  })

  it('detects a single missing period and reports its bounds', () => {
    recordInboundCandle(candle(1700000000))
    const ev = recordInboundCandle(candle(1700000120))
    expect(ev).not.toBeNull()
    expect(ev!.periods).toBe(1)
    expect(ev!.from).toBe(1700000060)
    expect(ev!.to).toBe(1700000060)
    expect(ev!.key).toBe('binance-futures:BTCUSDT:1m')
  })

  it('detects multiple missing periods and flags large gaps', () => {
    recordInboundCandle(candle(1700000000))
    const ev = recordInboundCandle(candle(1700000600)) // 10 minutes later
    expect(ev!.periods).toBe(9)
    expect(getCandleDiagStats().gapsSkippedLarge).toBe(0) // 9 < 10 threshold
    __test.resetCandleDiag()
    recordInboundCandle(candle(1700000000))
    recordInboundCandle(candle(1700001200)) // 20 minutes later
    expect(getCandleDiagStats().gapsSkippedLarge).toBe(1)
  })

  it('counts late candles without creating gap events', () => {
    recordInboundCandle(candle(1700000120))
    recordInboundCandle(candle(1700000060)) // older than the last seen
    expect(getCandleDiagStats().lateCandles).toBe(1)
    expect(getCandleDiagStats().gapsDetected).toBe(0)
  })

  it('flags anomalous candle ranges (phantom-candle watchdog)', () => {
    // First candle only records lastSeen; the second fills lastCandleRange.
    recordInboundCandle(candle(1700000000, { high: 50000, low: 48000 }))
    recordInboundCandle(candle(1700000060, { high: 50000, low: 48000 })) // range 2000
    recordInboundCandle(candle(1700000120, { high: 500000, low: 48000 })) // range 452000 > 25x
    expect(getCandleDiagStats().oddCandles).toBe(1)
  })

  it('tracks cumulative counters and recent gaps', () => {
    recordInboundCandle(candle(1700000000))
    recordInboundCandle(candle(1700000120))
    const stats = getCandleDiagStats()
    expect(stats.candlesReceived).toBe(2)
    expect(stats.gapsDetected).toBe(1)
    expect(stats.recentGaps.length).toBe(1)
  })
})

describe('createRemoteCandleManager', () => {
  beforeEach(() => {
    publishMock.mockClear()
  })

  it('publishes a subscribe request only on the first subscriber', () => {
    const manager = createRemoteCandleManager()
    manager.subscribeCandle('binance-futures', 'BTCUSDT', '1m')
    manager.subscribeCandle('binance-futures', 'BTCUSDT', '1m')
    expect(publishMock).toHaveBeenCalledTimes(1)
    const [channel, payload] = publishMock.mock.calls[0]
    expect(channel).toBe('sub-req')
    expect(JSON.parse(payload)).toEqual({ type: 'subscribe', exchange: 'binance-futures', symbol: 'BTCUSDT', tf: '1m' })
  })

  it('publishes an unsubscribe when the refcount reaches zero', () => {
    const manager = createRemoteCandleManager()
    manager.subscribeCandle('binance-futures', 'BTCUSDT', '1m')
    manager.subscribeCandle('binance-futures', 'BTCUSDT', '1m')
    manager.unsubscribeCandle('binance-futures', 'BTCUSDT', '1m')
    expect(publishMock).toHaveBeenCalledTimes(1) // still one subscriber
    manager.unsubscribeCandle('binance-futures', 'BTCUSDT', '1m')
    expect(publishMock).toHaveBeenCalledTimes(2)
    const [channel, payload] = publishMock.mock.calls[1]
    expect(JSON.parse(payload)).toEqual({ type: 'unsubscribe', exchange: 'binance-futures', symbol: 'BTCUSDT', tf: '1m' })
  })

  it('keys depth subscriptions separately from candles', () => {
    const manager = createRemoteCandleManager()
    manager.subscribeDepth('BTCUSDT')
    manager.subscribeCandle('binance-futures', 'BTCUSDT', '1m')
    manager.unsubscribeDepth('BTCUSDT')
    expect(publishMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(publishMock.mock.calls[0][1])).toEqual({ type: 'depth-sub', symbol: 'BTCUSDT' })
    expect(JSON.parse(publishMock.mock.calls[2][1])).toEqual({ type: 'depth-unsub', symbol: 'BTCUSDT' })
  })
})