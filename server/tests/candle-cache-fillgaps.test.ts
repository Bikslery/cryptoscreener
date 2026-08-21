import { describe, it, expect } from 'vitest'
import type { UnifiedCandle } from '../src/types.js'

// fillGaps is gated at module load — enable it BEFORE the dynamic import.
process.env.GAP_FILL_ENABLED = '1'

const { fillGaps } = await import('../src/services/candles/candle-cache.js')

const TF_SEC = 300

function candle(time: number, close = 100): UnifiedCandle {
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    timeframe: '5m',
    time,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
    isFinal: true,
  }
}

describe('fillGaps', () => {
  it('returns the input unchanged when there are no gaps', () => {
    const input = [candle(0), candle(TF_SEC), candle(2 * TF_SEC)]
    expect(fillGaps(input, 'BTCUSDT', 'binance-futures', '5m')).toBe(input)
  })

  it('fills a single missing period with a flat candle anchored to the previous close', () => {
    const filled = fillGaps([candle(0, 100), candle(2 * TF_SEC, 110)], 'BTCUSDT', 'binance-futures', '5m')
    expect(filled).toHaveLength(3)
    expect(filled[1].time).toBe(TF_SEC)
    expect(filled[1].close).toBe(100)
    expect(filled[1].volume).toBe(0)
    expect(filled[2].close).toBe(110)
  })

  it('advances the anchor after each gap (no duplicate timestamps)', () => {
    // Two separate holes in one series — the old implementation re-filled the
    // first region because `prev` was not advanced past the gap.
    const filled = fillGaps(
      [candle(0, 100), candle(2 * TF_SEC, 110), candle(5 * TF_SEC, 120)],
      'BTCUSDT', 'binance-futures', '5m',
    )
    const times = filled.map(c => c.time)
    expect(new Set(times).size).toBe(times.length) // strictly unique
    expect(times).toEqual([0, TF_SEC, 2 * TF_SEC, 3 * TF_SEC, 4 * TF_SEC, 5 * TF_SEC])
    expect(times.every((t, i) => i === 0 || t - times[i - 1] === TF_SEC)).toBe(true)
  })

  it('caps a huge gap at MAX_FILL_WINDOW periods', () => {
    const bigGapSec = 400 * TF_SEC
    const filled = fillGaps([candle(0, 100), candle(bigGapSec, 200)], 'BTCUSDT', 'binance-futures', '5m')
    // 399 missing periods requested → capped at 120 fillers + 2 real rows.
    expect(filled).toHaveLength(122)
    const lastFillerTime = filled[filled.length - 2].time
    expect(lastFillerTime).toBeLessThan(bigGapSec)
  })
})
