import { describe, it, expect } from 'vitest'
import { beginFormingGlide, advanceFormingGlide, type FormingGlide } from '../candle-anim'
import { easeOutCubic } from '../glide'

const displayed = { time: 300, open: 100, high: 110, low: 95, close: 100 }
const target = { time: 300, open: 100, high: 110, low: 95, close: 110 }

describe('forming-candle glide — time-based easing', () => {
  it('moves close with eased progress at half duration and does not converge', () => {
    const r = advanceFormingGlide(beginFormingGlide(displayed, target, 200), 100)
    // easeOutCubic(0.5) = 0.875 → close = 100 + 10·0.875
    expect(r.next.close).toBeCloseTo(108.75)
    expect(r.converged).toBe(false)
  })

  it('extends high/low toward the target with the same eased progress', () => {
    const t = { time: 300, open: 100, high: 112, low: 96, close: 108 }
    const r = advanceFormingGlide(beginFormingGlide(displayed, t, 100), 50)
    const p = easeOutCubic(0.5)
    expect(r.next.high).toBeCloseTo(110 + 2 * p) // high: 110 → 112
    expect(r.next.low).toBeCloseTo(95 + 1 * p) // low: 95 → 96
  })

  it('converges exactly once elapsed passes the duration', () => {
    let g: FormingGlide = beginFormingGlide(displayed, target, 90)
    let r = advanceFormingGlide(g, 90)
    g = r.glide
    expect(r.converged).toBe(true)
    expect(r.next.close).toBe(110)
    // Further frames keep the exact target — no drift past convergence.
    r = advanceFormingGlide(g, 16)
    expect(r.converged).toBe(true)
    expect(r.next.close).toBe(110)
  })

  it('keeps the bar time pinned to the target (never glides across periods)', () => {
    const t = { time: 360, open: 102, high: 103, low: 101, close: 102 }
    const r = advanceFormingGlide(beginFormingGlide(displayed, t, 100), 50)
    expect(r.next.time).toBe(360)
  })

  it('is monotonic toward the target — the body never overshoots', () => {
    let g = beginFormingGlide(displayed, target, 160)
    let cur = displayed
    let prevClose = cur.close
    let converged = false
    for (let i = 0; i < 30 && !converged; i++) {
      const r = advanceFormingGlide(g, 16)
      g = r.glide
      cur = r.converged ? { ...target } : r.next
      converged = r.converged
      expect(cur.close).toBeGreaterThanOrEqual(prevClose)
      expect(cur.close).toBeLessThanOrEqual(target.close)
      prevClose = cur.close
    }
    expect(converged).toBe(true)
    expect(cur.close).toBe(target.close)
  })
})
