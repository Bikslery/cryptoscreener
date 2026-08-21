import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as candleCache from '../candle-cache'
import { getOrFetchBulk, getOrFetchHistory } from '../candle-prefetch'
import type { UnifiedCandle } from '../../types'

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../api', () => ({
  default: {
    get: mockGet,
    post: mockPost,
  },
}))

function makeCandles(count: number, startTime = 1700000000): UnifiedCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: 'BTCUSDT',
    exchange: 'binance-futures' as const,
    timeframe: '5m' as const,
    time: startTime + i * 300,
    open: 100, high: 101, low: 99, close: 100,
    volume: 10,
  }))
}

describe('getOrFetchHistory — limit-aware cache semantics', () => {
  beforeEach(() => {
    // Clean the candle cache for the test key
    candleCache.clearAll()
    mockGet.mockReset()
    mockPost.mockReset()
  })

  it('serves the cache only when it covers the FULL requested window', async () => {
    // Mini charts seed the cache with 300 bars...
    candleCache.setCandles('binance-futures', 'BTCUSDT', '5m', makeCandles(300))

    // ...a 3000-bar request must NOT be satisfied by the 300-bar cache — the
    // expanded chart would render partially zoomed out and never fetch more.
    mockGet.mockResolvedValueOnce({ data: makeCandles(3000) })
    const candles = await getOrFetchHistory('BTCUSDT', '5m', 3000, 'binance-futures')

    expect(mockGet).toHaveBeenCalledTimes(1) // real fetch happened
    expect(candles.length).toBe(3000)
  })

  it('serves the cache without a network call when it covers the request', async () => {
    candleCache.setCandles('binance-futures', 'BTCUSDT', '5m', makeCandles(3000))

    const candles = await getOrFetchHistory('BTCUSDT', '5m', 300, 'binance-futures')
    expect(mockGet).not.toHaveBeenCalled()
    expect(candles.length).toBe(300)
  })

  it('does not deduplicate a 300-bar request against an in-flight 3000-bar one', async () => {
    // The mini-chart 300 fetch and the expanded-chart 3000 fetch are different
    // needs: the big chart must not receive the small one's partial result.
    mockGet.mockImplementation(() =>
      Promise.resolve({ data: makeCandles(3000) }),
    )
    const [small, big] = await Promise.all([
      getOrFetchHistory('BTCUSDT', '5m', 300, 'binance-futures'),
      getOrFetchHistory('BTCUSDT', '5m', 3000, 'binance-futures'),
    ])
    expect(big.length).toBe(3000)
    expect(small.length).toBe(300)
  })

  it('reuses an individual grid request that started before bulk registration', async () => {
    let resolveGet!: (value: { data: UnifiedCandle[] }) => void
    mockGet.mockReturnValueOnce(new Promise(resolve => { resolveGet = resolve }))
    mockPost.mockResolvedValueOnce({ data: { BTCUSDT: [] } })

    const individual = getOrFetchHistory('BTCUSDT', '5m', 300, 'binance-futures')
    const bulk = getOrFetchBulk(['BTCUSDT'], '5m', 300, 'binance-futures')

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockPost).not.toHaveBeenCalled()

    resolveGet({ data: makeCandles(300) })
    const [individualCandles, bulkResult] = await Promise.all([individual, bulk])

    expect(individualCandles).toHaveLength(300)
    expect(bulkResult.BTCUSDT).toHaveLength(300)
  })
})
