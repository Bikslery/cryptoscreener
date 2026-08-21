import { describe, expect, it } from 'vitest'
import { buildHistoryMeta } from '../src/services/candles/history-contract.js'
import type { UnifiedCandle } from '../src/types.js'

function candles(count: number): UnifiedCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: 'BTCUSDT', exchange: 'binance-futures' as const, timeframe: '1m',
    time: 1700000000 + i * 60, open: 1, high: 2, low: 1, close: 2, volume: 1,
  }))
}

describe('history response metadata', () => {
  it('marks a full requested window complete', () => {
    const meta = buildHistoryMeta(candles(300), { requestedLimit: 300, cached: true, generatedAt: 123 })
    expect(meta).toMatchObject({ status: 'complete', complete: true, noData: false, cached: true, generatedAt: 123 })
    expect(meta.nextBefore).toBe(1700000000)
    expect(meta.source).toBe('binance-futures')
    expect(meta.marketType).toBe('futures')
  })

  it('distinguishes a partial page from real end-of-history', () => {
    expect(buildHistoryMeta(candles(50), { requestedLimit: 300, cached: false }).status).toBe('partial')
    expect(buildHistoryMeta([], { requestedLimit: 300, cached: false })).toMatchObject({
      status: 'no_data', complete: false, noData: true, nextBefore: null,
    })
  })
})
