import { describe, it, expect } from 'vitest'
import { DEFAULT_DENSITY_SETTINGS, resolveDensitySettings, formatAge } from '../density'
import { calcTier } from '../density-cluster'
import type { DensityWall } from '../../types'

const NOW = Date.parse('2026-01-01T00:10:00Z')

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
  it('lifetime defaults are non-zero so transient walls are filtered', () => {
    expect(DEFAULT_DENSITY_SETTINGS.lifeSmall).toBe(1)
    expect(DEFAULT_DENSITY_SETTINGS.lifeMedium).toBe(3)
    expect(DEFAULT_DENSITY_SETTINGS.lifeLarge).toBe(5)
  })

  it('resolveDensitySettings backfills missing fields with defaults', () => {
    // Старые сохранённые настройки без life*-полей получают новые дефолты.
    const resolved = resolveDensitySettings({ mode: 'manual' })
    expect(resolved.lifeSmall).toBe(1)
    expect(resolved.lifeMedium).toBe(3)
    expect(resolved.lifeLarge).toBe(5)
  })
})

describe('calcTier lifetime gating', () => {
  const settings = resolveDensitySettings(undefined)
  // autoBrp нет → БРП = manualBrp 300k; multSmall=1 →Small ≥ 300k.

  it('rejects a wall younger than lifeSmall regardless of size', () => {
    // 30-секундная стена на 5М — «фейковая», не показывается.
    expect(calcTier(wall(NOW - 30_000, 5_000_000), settings, null, NOW)).toBeUndefined()
  })

  it('accepts a small-tier wall once it has lived past lifeSmall', () => {
    // 2 минуты, 400К: Small (≥300K, ≥1мин), но не Medium (≥600K).
    expect(calcTier(wall(NOW - 2 * 60_000, 400_000), settings, null, NOW)).toBe(3)
  })

  it('promotes by age: medium requires 3 min, large requires 5 min', () => {
    // 1.2М в 2 минуты: размер Medium, возраст — только Small.
    expect(calcTier(wall(NOW - 2 * 60_000, 1_200_000), settings, null, NOW)).toBe(3)
    // 1.2М в 4 минуты: Medium.
    expect(calcTier(wall(NOW - 4 * 60_000, 1_200_000), settings, null, NOW)).toBe(2)
    // 1.2М в 6 минут: Large (≥ 4×300К).
    expect(calcTier(wall(NOW - 6 * 60_000, 1_200_000), settings, null, NOW)).toBe(1)
  })
})

describe('formatAge', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatAge(NOW - 45_000, NOW)).toBe('45с')
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5м')
    expect(formatAge(NOW - (60 + 20) * 60_000, NOW)).toBe('1ч20м')
  })
})
