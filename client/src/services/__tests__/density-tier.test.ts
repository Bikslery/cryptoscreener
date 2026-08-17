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

describe('density defaults', () => {
  it('tier multipliers match scalpboard; lifetime default is 10 minutes', () => {
    // scalpboard: mult 2/3.5/5; их lifetime 30 мин, у нас 10 мин по настройке.
    expect(DEFAULT_DENSITY_SETTINGS.multSmall).toBe(2)
    expect(DEFAULT_DENSITY_SETTINGS.multMedium).toBe(3.5)
    expect(DEFAULT_DENSITY_SETTINGS.multLarge).toBe(5)
    expect(DEFAULT_DENSITY_SETTINGS.lifeSmall).toBe(10)
    expect(DEFAULT_DENSITY_SETTINGS.lifeMedium).toBe(10)
    expect(DEFAULT_DENSITY_SETTINGS.lifeLarge).toBe(10)
    expect(DEFAULT_DENSITY_SETTINGS.manualBrp).toBe(500_000)
  })

  it('resolveDensitySettings backfills missing fields with defaults', () => {
    // Старые сохранённые настройки без новых полей получают дефолты.
    const resolved = resolveDensitySettings({ mode: 'manual' })
    expect(resolved.multSmall).toBe(2)
    expect(resolved.lifeSmall).toBe(10)
    expect(resolved.lifeLarge).toBe(10)
  })
})

describe('calcTier — spoof filtering', () => {
  const settings = resolveDensitySettings(undefined)
  // autoBrp нет → БРП = manualBrp 500K. Малая ≥ 1M, средняя ≥ 1.75M, большая ≥ 2.5M.

  it('rejects a fresh wall regardless of size — spoofers are filtered', () => {
    // 30-секундная стена на 10М всё равно не показывается.
    expect(calcTier(wall(NOW - 30_000, 10_000_000), settings, null, NOW)).toBeUndefined()
    // и 8-минутная тоже
    expect(calcTier(wall(NOW - 8 * 60_000, 10_000_000), settings, null, NOW)).toBeUndefined()
  })

  it('accepts a wall once it has lived 10 minutes and cleared the size floor', () => {
    // 11 минут, 1.2М: Малая (≥1M), но не Средняя (≥1.75M).
    expect(calcTier(wall(NOW - 11 * 60_000, 1_200_000), settings, null, NOW)).toBe(3)
  })

  it('promotes purely by size once the lifetime gate is passed', () => {
    expect(calcTier(wall(NOW - 11 * 60_000, 2_000_000), settings, null, NOW)).toBe(2)
    expect(calcTier(wall(NOW - 11 * 60_000, 3_000_000), settings, null, NOW)).toBe(1)
  })

  it('walls below the small floor never show', () => {
    // 800K < 1M (2 × 500K): «не больше обычных заявок» — не плотность.
    expect(calcTier(wall(NOW - 11 * 60_000, 800_000), settings, null, NOW)).toBeUndefined()
  })
})

describe('formatAge', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatAge(NOW - 45_000, NOW)).toBe('45s')
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(formatAge(NOW - (60 + 20) * 60_000, NOW)).toBe('1h20m')
  })
})
