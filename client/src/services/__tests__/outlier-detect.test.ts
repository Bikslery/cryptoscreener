import { describe, it, expect } from 'vitest'
import { detectLocalOutliers, OUTLIER_RANGE_FACTOR } from '../candle-utils'
import type { OutlierCheckBar } from '../candle-utils'

function bar(close: number, range = 1): OutlierCheckBar {
  const half = range / 2
  return { open: close, high: close + half, low: close - half, close }
}

describe('detectLocalOutliers', () => {
  it('flags nothing on a clean steady series', () => {
    const candles = Array.from({ length: 50 }, (_, i) => bar(100 + i * 0.5))
    expect(detectLocalOutliers(candles).every(f => f === 0)).toBe(true)
  })

  it('flags a whole-bar price-level spike (10x close vs neighbors)', () => {
    const candles = Array.from({ length: 40 }, () => bar(100))
    candles[20] = bar(1000)
    expect(detectLocalOutliers(candles)[20]).toBe(1)
  })

  it('flags a single absurd wick (range >> neighborhood median)', () => {
    const candles = Array.from({ length: 40 }, () => bar(100, 1))
    candles[15] = { open: 100, high: 100 + 30 * OUTLIER_RANGE_FACTOR, low: 95, close: 100 }
    expect(detectLocalOutliers(candles)[15]).toBe(1)
  })

  it('keeps genuine volatility: a real 2x pump widens the window with itself', () => {
    // Price doubles over 10 bars — every bar stays within 4x of its window.
    const candles = Array.from({ length: 60 }, (_, i) => bar(100 * Math.pow(2, i / 10)))
    expect(detectLocalOutliers(candles).every(f => f === 0)).toBe(true)
  })

  it('returns all-zero flags for arrays too short to judge', () => {
    expect(detectLocalOutliers([bar(1), bar(9999), bar(1)]).every(f => f === 0)).toBe(true)
  })
})
