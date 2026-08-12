import { describe, it, expect, beforeEach } from 'vitest'
import { useAlertStore } from '../index'
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
