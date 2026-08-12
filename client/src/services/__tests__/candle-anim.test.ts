import { describe, it, expect } from 'vitest'
import { stepFormingAnimation } from '../candle-anim'

describe('stepFormingAnimation — smooth forming-candle glide', () => {
  it('moves close halfway toward the target with k=0.5 and does not converge', () => {
    const displayed = { time: 300, open: 100, high: 110, low: 95, close: 100 }
    const target = { time: 300, open: 100, high: 110, low: 95, close: 110 }
    const { next, converged } = stepFormingAnimation(displayed, target, 0.5)
    expect(next.close).toBe(105)
    expect(converged).toBe(false)
  })

  it('extends high/low toward the target', () => {
    const displayed = { time: 300, open: 100, high: 100, low: 100, close: 100 }
    const target = { time: 300, open: 100, high: 112, low: 96, close: 108 }
    const { next } = stepFormingAnimation(displayed, target, 0.5)
    expect(next.high).toBe(106)
    expect(next.low).toBe(98)
  })

  it('converges exactly with k=1 (snap)', () => {
    const displayed = { time: 300, open: 100, high: 110, low: 95, close: 100 }
    const target = { time: 300, open: 100, high: 110, low: 95, close: 108 }
    const { next, converged } = stepFormingAnimation(displayed, target, 1)
    expect(next.close).toBe(108)
    expect(converged).toBe(true)
  })

  it('keeps the bar time pinned to the target (never glides across periods)', () => {
    const displayed = { time: 300, open: 100, high: 110, low: 95, close: 100 }
    const target = { time: 360, open: 102, high: 103, low: 101, close: 102 }
    const { next } = stepFormingAnimation(displayed, target, 0.5)
    expect(next.time).toBe(360)
  })

  it('is monotonic toward the target — the body never overshoots', () => {
    const displayed = { time: 300, open: 100, high: 110, low: 95, close: 100 }
    const target = { time: 300, open: 100, high: 110, low: 95, close: 110 }
    let cur = displayed
    let prevClose = cur.close
    for (let i = 0; i < 30; i++) {
      const { next, converged } = stepFormingAnimation(cur, target, 0.4)
      expect(next.close).toBeGreaterThanOrEqual(prevClose)
      expect(next.close).toBeLessThanOrEqual(target.close)
      prevClose = next.close
      // Mirror the FormingAnimator: snap to the exact target on convergence.
      cur = converged ? { ...target } : next
      if (converged) break
    }
    expect(cur.close).toBe(target.close)
  })
})
