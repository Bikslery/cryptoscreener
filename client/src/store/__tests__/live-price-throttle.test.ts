import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setLivePrice, getLivePrice, subscribeLivePrice, flushLivePrices, setLivePriceInterval, resetLivePriceStore } from '../index'

// Vitest fake timers also fake Date.now(), so sweeps scheduled on the
// 1000ms cadence fire exactly when advanceTimersByTime moves the clock.
describe('live-price throttled publisher (1000ms cadence)', () => {
  beforeEach(() => {
    resetLivePriceStore() // store module is shared across tests in this file
    vi.useFakeTimers()
    setLivePriceInterval(1000)
  })

  afterEach(() => {
    flushLivePrices()
    vi.useRealTimers()
  })

  it('publishes the first price of a symbol immediately', () => {
    setLivePrice('A', 100)
    expect(getLivePrice('A')).toBe(100)
  })

  it('coalesces a burst within 1000ms into a single step with the latest value', () => {
    const listener = vi.fn()
    const unsub = subscribeLivePrice('A', listener)

    setLivePrice('A', 100) // immediate first commit (outside the count below)
    listener.mockClear()

    setLivePrice('A', 101)
    setLivePrice('A', 102)
    setLivePrice('A', 103)
    // Nothing published while inside the window.
    expect(getLivePrice('A')).toBe(100)
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    // Latest-wins: exactly ONE step, to the newest value.
    expect(getLivePrice('A')).toBe(103)
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('continues on the cadence even after a step (next commit at the boundary)', () => {
    setLivePrice('A', 100) // first → immediate
    setLivePrice('A', 102) // queued
    vi.advanceTimersByTime(1000) // -> 102 committed at the 1000ms boundary
    expect(getLivePrice('A')).toBe(102)

    setLivePrice('A', 250) // within the window again → queued, not instant
    expect(getLivePrice('A')).toBe(102)
    vi.advanceTimersByTime(1000) // -> 250 committed on the next boundary
    expect(getLivePrice('A')).toBe(250)
  })

  it('flushLivePrices synchronously publishes pending values', () => {
    setLivePrice('A', 100)
    setLivePrice('A', 999) // queued
    expect(getLivePrice('A')).toBe(100)
    flushLivePrices()
    expect(getLivePrice('A')).toBe(999)
  })

  it('skips subscribers when the value is unchanged', () => {
    const listener = vi.fn()
    const unsub = subscribeLivePrice('A', listener)
    setLivePrice('A', 100) // first price → immediate publish, listener fires once
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()
    setLivePrice('A', 100)
    setLivePrice('A', 100)
    vi.advanceTimersByTime(1000)
    expect(getLivePrice('A')).toBe(100)
    expect(listener).not.toHaveBeenCalled() // unchanged value → no re-notify
    unsub()
  })
})
