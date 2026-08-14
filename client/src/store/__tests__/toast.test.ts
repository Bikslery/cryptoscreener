import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useToastStore } from '../toast'
import type { Alert } from '../../types'

function impulseAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1',
    userId: 'u1',
    type: 'impulse',
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    condition: { percent: 3, timeframe: '5m', direction: 'down', volumeSpike: 2, exchanges: [{ exchange: 'binance-futures', minVolume24h: 0 }] },
    price: 67000,
    movePct: -4.2,
    active: true,
    muted: false,
    triggeredAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

function priceAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'p1',
    userId: 'u1',
    type: 'price',
    symbol: 'ETHUSDT',
    exchange: 'binance-futures',
    condition: { price: 3000, direction: 'above' },
    price: 3001,
    active: false,
    muted: false,
    triggeredAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useToastStore — showAlert', () => {
  it('adds an impulse toast with ticker + movement accent', () => {
    useToastStore.getState().showAlert(impulseAlert())
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('alert')
    expect(toasts[0].position).toBe('bottom-right')
    expect(toasts[0].alertData?.symbol).toBe('BTC')
    expect(toasts[0].alertData?.accent).toBe('-4.2%')
    expect(toasts[0].alertData?.accentTone).toBe('down')
    expect(toasts[0].alertData?.sub).toContain('вниз')
    expect(toasts[0].alertData?.sub).toContain('об ×2')
    expect(toasts[0].alertData?.sub).toContain('Binance Futures')
  })

  it('honors the requested position', () => {
    useToastStore.getState().showAlert(impulseAlert(), { position: 'bottom-left' })
    expect(useToastStore.getState().toasts[0].position).toBe('bottom-left')
  })

  it('builds a price toast with the crossing level', () => {
    useToastStore.getState().showAlert(priceAlert())
    const t = useToastStore.getState().toasts[0]
    expect(t.alertData?.accent).toBe('')
    expect(t.alertData?.sub).toMatch(/\$3,001/)
    expect(t.alertData?.sub).toContain('выше')
  })
})

describe('useToastStore — stacking and caps', () => {
  it('stacks multiple toasts (newest prepended to the same corner)', () => {
    for (let i = 0; i < 3; i++) {
      useToastStore.getState().showAlert(impulseAlert({ id: `a${i}` }))
    }
    expect(useToastStore.getState().toasts).toHaveLength(3)
  })

  it('drops the oldest toast when the corner stack exceeds 6', () => {
    for (let i = 1; i <= 8; i++) {
      useToastStore.getState().showAlert(impulseAlert({ id: `a${i}` }))
    }
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(6)
    // The two oldest were pruned — the newest (highest toast id) remains.
    const maxId = Math.max(...toasts.map(t => t.id))
    expect(toasts.map(t => t.id).sort((x, y) => x - y)).toEqual(Array.from({ length: 6 }, (_, k) => maxId - 5 + k))
  })
})

describe('useToastStore — dismiss and dismissAll', () => {
  it('dismisses a single toast by id', () => {
    useToastStore.getState().showAlert(impulseAlert({ id: 'a1' }))
    useToastStore.getState().showAlert(impulseAlert({ id: 'a2' }))
    useToastStore.getState().dismiss(useToastStore.getState().toasts[0].id)
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('dismissAll clears every toast including messages', () => {
    useToastStore.getState().show('hello')
    useToastStore.getState().showAlert(impulseAlert({ id: 'a1' }))
    useToastStore.getState().showAlert(impulseAlert({ id: 'a2' }))
    useToastStore.getState().dismissAll()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('auto-dismisses after the configured duration', () => {
    vi.useFakeTimers()
    useToastStore.getState().showAlert(impulseAlert({ id: 'a1' }), { duration: 20000 })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(19999)
    expect(useToastStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
