import type { UnifiedCandle } from '../types'

export function isFiniteOHLCV(c: { open: number; high: number; low: number; close: number; volume: number }): boolean {
  return isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) && isFinite(c.volume)
}

export function validateCandle(c: UnifiedCandle): boolean {
  if (!isFiniteOHLCV(c)) return false
  if (c.high < c.low) return false
  if (c.high < c.open || c.high < c.close) return false
  if (c.low > c.open || c.low > c.close) return false
  if (c.volume < 0) return false
  if (!c.time || c.time <= 0) return false
  return true
}

export function normalizeCandle<T extends UnifiedCandle>(c: T): T {
  if (!isFiniteOHLCV(c)) return c
  const all = [c.open, c.high, c.low, c.close]
  const h = Math.max(...all)
  const l = Math.min(...all)
  if (c.high === h && c.low === l) return c
  return { ...c, high: h, low: l }
}
