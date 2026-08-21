import { describe, expect, it } from 'vitest'
import {
  canPaintPartialHistory,
  resolveHistoryViewportAction,
} from '../chart-history-paint'

describe('chart history background paint policy', () => {
  it('keeps the current viewport when deeper history arrives after first paint', () => {
    expect(resolveHistoryViewportAction({
      hasViewport: true,
      fitOnOpen: true,
    })).toBe('restore')
  })

  it('fits an expanded chart only on its first paint', () => {
    expect(resolveHistoryViewportAction({
      hasViewport: false,
      fitOnOpen: true,
    })).toBe('fit')
  })

  it('opens mini charts on their recent window', () => {
    expect(resolveHistoryViewportAction({
      hasViewport: false,
      fitOnOpen: false,
    })).toBe('recent')
  })

  it('can immediately paint any non-empty websocket/cache tail', () => {
    expect(canPaintPartialHistory(64)).toBe(true)
    expect(canPaintPartialHistory(1)).toBe(true)
    expect(canPaintPartialHistory(0)).toBe(false)
  })
})
