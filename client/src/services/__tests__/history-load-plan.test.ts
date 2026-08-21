import { describe, expect, it } from 'vitest'
import { resolveHistoryLoadPlan } from '../history-load-plan'

describe('progressive history load plan', () => {
  it('loads a visible tail before deep expanded history', () => {
    expect(resolveHistoryLoadPlan({ cachedCount: 0, initialLimit: 300, targetLimit: 3000 }))
      .toEqual([300, 3000])
  })

  it('skips the tail request when it is already cached', () => {
    expect(resolveHistoryLoadPlan({ cachedCount: 300, initialLimit: 300, targetLimit: 3000 }))
      .toEqual([3000])
  })

  it('does no network work when the full target is cached', () => {
    expect(resolveHistoryLoadPlan({ cachedCount: 3000, initialLimit: 300, targetLimit: 3000 }))
      .toEqual([])
  })
})
