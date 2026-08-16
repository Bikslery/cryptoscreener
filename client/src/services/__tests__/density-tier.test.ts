import { describe, it, expect } from 'vitest'
import { DEFAULT_DENSITY_SETTINGS, resolveDensitySettings, formatAge } from '../density'
import { calcTier } from '../density-cluster'
import type { DensityWall } from '../../types'

const NOW = Date.parse('2026-01-01T01:00:00Z')

function wall(bornAt: number, sizeUsdt: number): DensityWall {
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    side: 'bid',
    price: 100,
    sizeUsdt,
    bornAt,
    roundNumber: false,
  }
}

describe('density defaults (scalpboard parity)', () => {
  it('tier multipliers and lifetimes match scalpboard bundle defaults', () => {
    // tiers: [{large ×5}, {medium ×3.5}, {small ×2}], time:1800s = 30 min
    expect(DEFAULT_DENSITY_SETTINGS.multSmall).toBe(2)
    expect(DEFAULT_DENSITY_SETTINGS.multMedium).toBe(3.5)
    expect(DEFAULT_DENSITY_SETTINGS.multLarge).toBe(5)
    expect(DEFAULT_DENSITY_SETTINGS.lifeSmall).toBe(30)
    expect(DEFAULT_DENSITY_SETTINGS.lifeMedium).toBe(30)
    expect(DEFAULT_DENSITY_SETTINGS.lifeLarge).toBe(30)
    expect(DEFAULT_DENSITY_SETTINGS.manualBrp).toBe(500_000)
  })

  it('resolveDensitySettings backfills missing fields with defaults', () => {
    // Старые сохранённые настройки без новых полей получают дефолты scalpboard.
    const resolved = resolveDensitySettings({ mode: 'manual' })
    expect(resolved.multSmall).toBe(2)
    expect(resolved.lifeSmall).toBe(30)
    expect(resolved.lifeLarge).toBe(30)
  })
})

describe('calcTier — spoof filtering (scalpboard math)', () => {
  const settings = resolveDensitySettings(undefined)
  // autoBrp нет → БРП = manualBrp 500K. Малая ≥ 1M, средняя ≥ 1.75M, большая ≥ 2.5M.

  it('rejects a fresh wall regardless of size — spoofers are filtered', () => {
    // 30-секундная стена на 10М всё равно не показывается.
    expect(calcTier(wall(NOW - 30_000, 10_000_000), settings, null, NOW)).toBeUndefined()
    // и 29-минутная тоже
    expect(calcTier(wall(NOW - 29 * 60_000, 10_000_000), settings, null, NOW)).toBeUndefined()
  })

  it('accepts a wall once it has lived 30 minutes and cleared the size floor', () => {
    // 31 минута, 1.2М: Малая (≥1M), но не Средняя (≥1.75M).
    expect(calcTier(wall(NOW - 31 * 60_000, 1_200_000), settings, null, NOW)).toBe(3)
  })

  it('promotes purely by size once the lifetime gate is passed', () => {
    expect(calcTier(wall(NOW - 31 * 60_000, 2_000_000), settings, null, NOW)).toBe(2)
    expect(calcTier(wall(NOW - 31 * 60_000, 3_000_000), settings, null, NOW)).toBe(1)
  })

  it('walls below the small floor never show', () => {
    // 800K < 1M (2 × 500K): «не больше обычных заявок» — не плотность.
    expect(calcTier(wall(NOW - 31 * 60_000, 800_000), settings, null, NOW)).toBeUndefined()
  })
})

describe('formatAge', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatAge(NOW - 45_000, NOW)).toBe('45с')
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5м')
    expect(formatAge(NOW - (60 + 20) * 60_000, NOW)).toBe('1ч20м')
  })
})
