import { describe, expect, it } from 'vitest'
import { formatCompact, getPrecisionFromTickSize, getPrecisionFromPrice, formatPrice, snapToTick, extractBaseAsset } from '../format'

describe('formatCompact', () => {
  it('formats plain numbers below 1K without a suffix', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(5)).toBe('5')
    expect(formatCompact(123)).toBe('123')
    expect(formatCompact(999)).toBe('999')
  })

  it('keeps one decimal in the K/M/B range (no integer rounding artifacts)', () => {
    expect(formatCompact(1500)).toBe('1.5K')
    expect(formatCompact(12345)).toBe('12.3K')
    expect(formatCompact(123456)).toBe('123K')
    expect(formatCompact(1234567)).toBe('1.2M')
    expect(formatCompact(1490000)).toBe('1.5M')
    expect(formatCompact(1500000000)).toBe('1.5B')
  })

  it('trims trailing .0 (1K, not 1.0K)', () => {
    expect(formatCompact(1000)).toBe('1K')
    expect(formatCompact(1000000)).toBe('1M')
    expect(formatCompact(1000000000)).toBe('1B')
  })

  it('carries over the unit boundary when rounding fills a unit', () => {
    expect(formatCompact(999999)).toBe('1M')
    expect(formatCompact(999999999)).toBe('1B')
    expect(formatCompact(999500)).toBe('1M')
  })

  it('supports T and negative values', () => {
    expect(formatCompact(1234567890123)).toBe('1.2T')
    expect(formatCompact(-1500)).toBe('-1.5K')
  })

  it('non-finite input passes through', () => {
    expect(formatCompact(NaN)).toBe('NaN')
    expect(formatCompact(Infinity)).toBe('Infinity')
  })
})

describe('getPrecisionFromTickSize', () => {
  it('reads decimals off the tick size string', () => {
    expect(getPrecisionFromTickSize('0.01')).toBe(2)
    expect(getPrecisionFromTickSize('0.00001')).toBe(5)
    expect(getPrecisionFromTickSize('1')).toBe(0)
  })
})

describe('getPrecisionFromPrice', () => {
  it('infers precision from the price magnitude', () => {
    expect(getPrecisionFromPrice(65000)).toBe(2)
    expect(getPrecisionFromPrice(0.0000123)).toBeGreaterThan(4)
  })
})

describe('formatPrice', () => {
  it('groups thousands for big prices', () => {
    expect(formatPrice(65432.1, 2)).toBe('65,432.10')
    expect(formatPrice(12.345, 2)).toBe('12.35')
  })
})

describe('snapToTick — the стакан grid', () => {
  it('rounds a price onto the exchange tick grid', () => {
    // Mid of bid 67123.5 / ask 67123.6 = 67123.55 — off-grid, must land on a
    // book level (round-half-up → the nearest tick, 67123.6).
    expect(snapToTick(67123.55, 1)).toBeCloseTo(67123.6, 10)
    expect(snapToTick(0.123456, 4)).toBeCloseTo(0.1235, 10)
    expect(snapToTick(1.23456, 3)).toBeCloseTo(1.235, 10)
    expect(snapToTick(100, 0)).toBe(100)
  })

  it('is a no-op for values already on the grid', () => {
    expect(snapToTick(67123.5, 1)).toBe(67123.5)
    expect(snapToTick(2.3456, 4)).toBeCloseTo(2.3456, 10)
  })

  it('passes through non-positive and non-finite prices untouched', () => {
    expect(snapToTick(0, 2)).toBe(0)
    expect(snapToTick(-5, 2)).toBe(-5)
    expect(snapToTick(Number.NaN, 2)).toBeNaN()
  })
})

describe('extractBaseAsset', () => {
  it('strips the quote asset from a symbol', () => {
    expect(extractBaseAsset('BTCUSDT')).toBe('BTC')
    expect(extractBaseAsset('1000PEPEUSDT')).toBe('1000PEPE')
    expect(extractBaseAsset('ETH/BTC')).toBe('ETH')
  })
})
