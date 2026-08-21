import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginForegroundHistory,
  getHistoryPriorityState,
  waitForHistoryBackgroundSlot,
} from '../src/services/candles/history-priority.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('history request priority', () => {
  it('holds background work while a foreground history request is active', async () => {
    vi.useFakeTimers()
    const releaseForeground = beginForegroundHistory()
    let backgroundStarted = false

    const waiting = waitForHistoryBackgroundSlot({ quietPeriodMs: 0, pollMs: 10 })
      .then(() => { backgroundStarted = true })

    await vi.advanceTimersByTimeAsync(100)
    expect(backgroundStarted).toBe(false)
    expect(getHistoryPriorityState().foregroundActive).toBe(1)

    releaseForeground()
    await vi.advanceTimersByTimeAsync(10)
    await waiting

    expect(backgroundStarted).toBe(true)
    expect(getHistoryPriorityState().foregroundActive).toBe(0)
  })

  it('waits for a quiet period after the last foreground request', async () => {
    vi.useFakeTimers()
    const releaseForeground = beginForegroundHistory()
    releaseForeground()

    let backgroundStarted = false
    const waiting = waitForHistoryBackgroundSlot({ quietPeriodMs: 50, pollMs: 10 })
      .then(() => { backgroundStarted = true })

    await vi.advanceTimersByTimeAsync(40)
    expect(backgroundStarted).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    await waiting
    expect(backgroundStarted).toBe(true)
  })
})
