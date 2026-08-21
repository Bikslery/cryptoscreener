const DEFAULT_QUIET_PERIOD_MS = 250
const DEFAULT_POLL_MS = 25

let foregroundActive = 0
let lastForegroundAt = 0
let backgroundWaiters = 0
let backgroundWaitMsTotal = 0

/**
 * Mark a user-visible history operation as active. The returned release
 * function is idempotent so route timeouts and finally blocks cannot drive
 * the counter below zero.
 */
export function beginForegroundHistory(): () => void {
  foregroundActive++
  lastForegroundAt = Date.now()
  let released = false
  return () => {
    if (released) return
    released = true
    foregroundActive = Math.max(0, foregroundActive - 1)
    lastForegroundAt = Date.now()
  }
}

export interface BackgroundSlotOptions {
  quietPeriodMs?: number
  pollMs?: number
}

/**
 * Background preload/repair waits until no visible chart request is running
 * and a short quiet period has elapsed. This preserves exchange REST/rate
 * budget for the user without cancelling useful background work.
 */
export async function waitForHistoryBackgroundSlot(options: BackgroundSlotOptions = {}): Promise<void> {
  const quietPeriodMs = options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const startedAt = Date.now()
  backgroundWaiters++
  try {
    while (foregroundActive > 0 || Date.now() - lastForegroundAt < quietPeriodMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  } finally {
    backgroundWaiters = Math.max(0, backgroundWaiters - 1)
    backgroundWaitMsTotal += Date.now() - startedAt
  }
}

export function getHistoryPriorityState() {
  return {
    foregroundActive,
    backgroundWaiters,
    backgroundWaitMsTotal,
    lastForegroundAt,
  }
}
