import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/db/index.js', () => ({
  prisma: { alert: { findMany: vi.fn(), update: vi.fn() }, user: { findUnique: vi.fn() } },
}))
vi.mock('../src/services/aggregator/index.js', () => ({
  getTickers: vi.fn(() => []),
  getAllTickers: vi.fn(() => []),
  fetchCandles: vi.fn(async () => []),
  anyLimiterOverThreshold: vi.fn(() => false),
}))
vi.mock('../src/services/candles/candle-cache.js', () => ({
  getCachedCandles: vi.fn(() => []),
  setCachedCandles: vi.fn(),
}))
vi.mock('../src/ws/hub.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/redis.js', () => ({ getRedisPub: vi.fn(), REDIS_ENABLED: false }))
vi.mock('../src/services/telegram/bot.js', () => ({ sendTelegramMessage: vi.fn(async () => {}) }))

import { cooldownActive } from '../src/services/alerts/index.js'

describe('cooldownActive — per-user+symbol 60s notification cooldown', () => {
  it('allows the first firing for a user+coin', () => {
    expect(cooldownActive('u1', 'BTCUSDT')).toBe(false)
  })

  it('suppresses a second firing for the same user+coin within the window', () => {
    expect(cooldownActive('u2', 'SOLUSDT')).toBe(false)
    expect(cooldownActive('u2', 'SOLUSDT')).toBe(true)
  })

  it('does not suppress a different coin or a different user', () => {
    expect(cooldownActive('u3', 'ETHUSDT')).toBe(false)
    expect(cooldownActive('u4', 'ETHUSDT')).toBe(false)
  })

  it('re-allows the same user+coin after 60s', () => {
    vi.useFakeTimers()
    try {
      expect(cooldownActive('u5', 'XRPUSDT')).toBe(false)
      vi.advanceTimersByTime(61_000)
      expect(cooldownActive('u5', 'XRPUSDT')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
