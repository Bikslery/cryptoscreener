import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  easeOutCubic,
  glideDurationFor,
  beginScalarGlide,
  advanceScalarGlide,
  registerGlider,
  unregisterGlider,
  type Glider,
} from '../glide'

describe('easeOutCubic', () => {
  it('starts fast and decelerates into the target', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875)
    const d1 = easeOutCubic(0.5) - easeOutCubic(0.25)
    const d2 = easeOutCubic(0.75) - easeOutCubic(0.5)
    expect(d2).toBeLessThan(d1) // decelerating
  })

  it('clamps out-of-range progress', () => {
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
  })
})

describe('glideDurationFor — adaptive speed', () => {
  it('snaps on live pairs, glides long on quiet ones', () => {
    expect(glideDurationFor(20)).toBe(0) // dozens of updates/sec → snap, no chase
    expect(glideDurationFor(50)).toBe(0) // still live → snap
    expect(glideDurationFor(100)).toBe(150) // barely-live → short glide
    expect(glideDurationFor(1000)).toBe(160) // quiet symbol → long smooth glide
    expect(glideDurationFor(0)).toBe(160) // unknown interval → default
  })
})

describe('scalar glide math', () => {
  it('moves partway with eased progress and converges exactly at the duration', () => {
    let g = beginScalarGlide(100, 110, 100)
    const r1 = advanceScalarGlide(g, 50)
    g = r1.glide
    expect(r1.converged).toBe(false)
    expect(r1.next).toBeGreaterThan(100)
    expect(r1.next).toBeLessThan(110)
    expect(r1.next).toBeCloseTo(100 + 10 * easeOutCubic(0.5))
    const r2 = advanceScalarGlide(g, 50)
    expect(r2.converged).toBe(true)
    expect(r2.next).toBe(110)
  })

  it('stays on the exact target after convergence (no overshoot drift)', () => {
    let g = beginScalarGlide(100, 108, 90)
    let r = advanceScalarGlide(g, 90)
    expect(r.converged).toBe(true)
    expect(r.next).toBe(108)
    g = r.glide
    r = advanceScalarGlide(g, 30)
    expect(r.next).toBe(108)
  })

  it('a zero-duration glide (live pair) snaps on the first step', () => {
    let g = beginScalarGlide(100, 110, 0)
    let r = advanceScalarGlide(g, 16.7)
    expect(r.converged).toBe(true)
    expect(r.next).toBe(110)
    g = r.glide
    r = advanceScalarGlide(g, 16.7)
    expect(r.next).toBe(110)
  })
})

describe('shared rAF coordinator', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drives all gliders from a single frame loop and stops when empty', () => {
    const rafCallbacks: Array<(t: number) => void> = []
    const cancelSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', cancelSpy)
    vi.stubGlobal('performance', { now: () => 0 })

    const ticksA: number[] = []
    const a: Glider = { tick: (dt) => { ticksA.push(dt); return false } } // converges immediately
    const ticksB: number[] = []
    const b: Glider = { tick: (dt) => { ticksB.push(dt); return true } } // keeps gliding

    registerGlider(a)
    registerGlider(b)
    expect(rafCallbacks.length).toBe(1) // one shared loop for both

    rafCallbacks[0](16.7)
    expect(ticksA).toEqual([16.7]) // first frame: dt = 16.7 (no previous timestamp)
    expect(ticksB).toEqual([16.7])
    expect(rafCallbacks.length).toBe(2) // a done, b keeps → rescheduled

    unregisterGlider(b)
    expect(cancelSpy).toHaveBeenCalled() // loop stops when the last glider leaves
  })

  it('does not reschedule when the last glider converges on the first frame', () => {
    const rafCallbacks: Array<(t: number) => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('performance', { now: () => 0 })

    const g: Glider = { tick: () => false }
    registerGlider(g)
    rafCallbacks[0](16.7)
    expect(rafCallbacks.length).toBe(1) // no reschedule after convergence
  })

  it('measures dt between consecutive frames, clamped for background tabs', () => {
    const rafCallbacks: Array<(t: number) => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('performance', { now: () => 0 })

    const dts: number[] = []
    const g: Glider = { tick: (dt) => { dts.push(dt); return dts.length < 3 } }
    registerGlider(g)
    rafCallbacks[0](16.7) // first: no baseline → 16.7
    rafCallbacks[1](50) // 33.3ms gap
    rafCallbacks[2](10000) // huge gap → clamped to 100
    expect(dts).toEqual([16.7, 33.3, 100])
  })
})
