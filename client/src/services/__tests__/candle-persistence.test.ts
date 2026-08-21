import { describe, expect, it } from 'vitest'
import { selectPersistentTail } from '../candle-persistence'
import type { UnifiedCandle } from '../../types'

function candles(count: number): UnifiedCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: 'BTCUSDT',
    exchange: 'binance-futures' as const,
    timeframe: '1m',
    time: 1700000000 + i * 60,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }))
}

describe('persistent candle tail', () => {
  it('stores only the newest 300 validated candles', () => {
    const selected = selectPersistentTail(candles(500))
    expect(selected).toHaveLength(300)
    expect(selected[0].time).toBe(candles(500)[200].time)
    expect(selected[299].time).toBe(candles(500)[499].time)
  })

  it('drops malformed rows before persistence', () => {
    const rows = candles(2)
    rows.push({ ...rows[1], time: rows[1].time + 60, high: 1, low: 2 })
    expect(selectPersistentTail(rows)).toHaveLength(2)
  })
})
