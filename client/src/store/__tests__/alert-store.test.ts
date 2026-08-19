import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAlertStore, shouldNotifyAlert, __resetAlertNotifyDedup } from '../index'
import { onAlertRemoved } from '../../services/alert-drawing-sync'
import type { Alert } from '../../types'

function makeAlert(id: string, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    userId: 'u1',
    type: 'price',
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    condition: { price: 65000, direction: 'above' },
    active: true,
    muted: false,
    triggeredAt: null,
    createdAt: 1700000000000,
    ...overrides,
  }
}

describe('useAlertStore — addCreated', () => {
  beforeEach(() => {
    useAlertStore.setState({ alerts: [] })
  })

  it('prepends a created alert so it is visible on the page right away', () => {
    useAlertStore.getState().addCreated(makeAlert('a1'))
    expect(useAlertStore.getState().alerts).toHaveLength(1)
    expect(useAlertStore.getState().alerts[0].id).toBe('a1')
  })

  it('does not duplicate an alert that is already in the list', () => {
    useAlertStore.getState().addCreated(makeAlert('a1'))
    useAlertStore.getState().addCreated(makeAlert('a1', { active: false }))
    expect(useAlertStore.getState().alerts).toHaveLength(1)
  })

  it('caps the list at 100 entries', () => {
    for (let i = 0; i < 120; i++) {
      useAlertStore.getState().addCreated(makeAlert(`a${i}`))
    }
    expect(useAlertStore.getState().alerts).toHaveLength(100)
  })
})

describe('useAlertStore — dismissAlert', () => {
  beforeEach(() => {
    useAlertStore.setState({ alerts: [] })
  })

  it('removes the alert from the list', () => {
    useAlertStore.getState().addCreated(makeAlert('a1'))
    useAlertStore.getState().dismissAlert('a1')
    expect(useAlertStore.getState().alerts).toHaveLength(0)
  })

  it('emits alertRemoved so every chart drops the linked ray', () => {
    const seen: string[] = []
    const unsub = onAlertRemoved((id) => seen.push(id))
    try {
      useAlertStore.getState().dismissAlert('al-7')
      expect(seen).toEqual(['al-7'])
    } finally {
      unsub()
    }
  })
})

describe('useAlertStore — updateAlert', () => {
  beforeEach(() => {
    useAlertStore.setState({ alerts: [] })
  })

  it('replaces the stored alert with the server PATCH result', () => {
    useAlertStore.getState().addCreated(makeAlert('a1'))
    useAlertStore.getState().updateAlert(makeAlert('a1', { active: false, condition: { price: 70000, direction: 'below' } }))
    const updated = useAlertStore.getState().alerts[0]
    expect(updated.active).toBe(false)
    expect(updated.condition).toEqual({ price: 70000, direction: 'below' })
  })

  it('is a no-op when the alert is not in the list', () => {
    useAlertStore.getState().updateAlert(makeAlert('ghost'))
    expect(useAlertStore.getState().alerts).toHaveLength(0)
  })
})

describe('shouldNotifyAlert — notification anti-spam', () => {
  beforeEach(() => {
    __resetAlertNotifyDedup()
  })

  it('suppresses a duplicate delivery of the same alert id (double-broadcast guard)', () => {
    const a = makeAlert('imp-x1', { type: 'impulse', symbol: 'BTCUSDT' })
    expect(shouldNotifyAlert(a)).toBe(true)
    expect(shouldNotifyAlert(a)).toBe(false)
  })

  it('suppresses a second impulse on the same symbol within the burst window', () => {
    const a1 = makeAlert('imp-x2', { type: 'impulse', symbol: 'BTCUSDT' })
    const a2 = makeAlert('imp-x3', { type: 'impulse', symbol: 'BTCUSDT' })
    expect(shouldNotifyAlert(a1)).toBe(true)
    expect(shouldNotifyAlert(a2)).toBe(false)
  })

  it('notifies an impulse on a different symbol', () => {
    expect(shouldNotifyAlert(makeAlert('imp-x4', { type: 'impulse', symbol: 'BTCUSDT' }))).toBe(true)
    expect(shouldNotifyAlert(makeAlert('imp-x5', { type: 'impulse', symbol: 'ETHUSDT' }))).toBe(true)
  })

  it('does not coalesce price alerts by symbol (only impulses)', () => {
    expect(shouldNotifyAlert(makeAlert('prc-x1', { type: 'price', symbol: 'BTCUSDT' }))).toBe(true)
    expect(shouldNotifyAlert(makeAlert('prc-x2', { type: 'price', symbol: 'BTCUSDT' }))).toBe(true)
  })

  it('re-notifies the same alert id after the dedup window expires', () => {
    vi.useFakeTimers()
    try {
      const a = makeAlert('imp-x6', { type: 'impulse', symbol: 'BTCUSDT' })
      expect(shouldNotifyAlert(a)).toBe(true)
      vi.advanceTimersByTime(11_000)
      expect(shouldNotifyAlert(a)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
