import { describe, it, expect } from 'vitest'
import { applyCandleUpdates } from '../candle-merge'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance_futures' as Exchange
const SYM = 'BTCUSDT'
const TF = '1m'

function makeCandle(time: number, close = 100, open = 100, high = Math.max(open, close), low = Math.min(open, close)): UnifiedCandle {
  return { symbol: SYM, exchange: EX, timeframe: TF, time, open, high, low, close, volume: 1, source: 'kline' }
}

describe('applyCandleUpdates — sorted upsert + out-of-order detection', () => {
  it('appends newer candles (incremental path) and returns false', () => {
    const arr = [makeCandle(100), makeCandle(200)]
    const outOfOrder = applyCandleUpdates(arr, [makeCandle(300), makeCandle(400)])
    expect(outOfOrder).toBe(false)
    expect(arr.map(c => c.time)).toEqual([100, 200, 300, 400])
  })

  it('replaces the last candle in place and returns false', () => {
    const arr = [makeCandle(100), makeCandle(200)]
    const outOfOrder = applyCandleUpdates(arr, [makeCandle(200, 205, 100, 210, 99)])
    expect(outOfOrder).toBe(false)
    expect(arr).toHaveLength(2)
    expect(arr[1].close).toBe(205)
  })

  it('inserts an older candle in the middle (gap-backfill) and returns true', () => {
    const arr = [makeCandle(240), makeCandle(300)]
    // Gap candle for period 360? No — for period 180 (older than tail start) and 270 (between).
    const outOfOrder = applyCandleUpdates(arr, [makeCandle(270, 110, 105, 112, 104)])
    expect(outOfOrder).toBe(true)
    expect(arr.map(c => c.time)).toEqual([240, 270, 300])
    expect(arr[1].close).toBe(110)
  })

  it('updates an existing middle candle (delayed kline) and returns true', () => {
    const arr = [makeCandle(240), makeCandle(300), makeCandle(360)]
    const outOfOrder = applyCandleUpdates(arr, [makeCandle(300, 115, 100, 116, 99)])
    expect(outOfOrder).toBe(true)
    expect(arr).toHaveLength(3)
    expect(arr[1].close).toBe(115)
  })

  it('handles a mixed patch (older + newer) with sorted result and returns true', () => {
    const arr = [makeCandle(240), makeCandle(360)]
    const outOfOrder = applyCandleUpdates(arr, [makeCandle(300, 108), makeCandle(420, 112)])
    expect(outOfOrder).toBe(true)
    expect(arr.map(c => c.time)).toEqual([240, 300, 360, 420])
  })

  it('inserts before the first element when the candle is older than everything', () => {
    const arr = [makeCandle(300), makeCandle(360)]
    const outOfOrder = applyCandleUpdates(arr, [makeCandle(240, 106)])
    expect(outOfOrder).toBe(true)
    expect(arr.map(c => c.time)).toEqual([240, 300, 360])
  })

  it('returns false for an empty patch', () => {
    const arr = [makeCandle(100)]
    expect(applyCandleUpdates(arr, [])).toBe(false)
    expect(arr).toHaveLength(1)
  })
})
