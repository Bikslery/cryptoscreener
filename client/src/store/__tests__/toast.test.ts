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
    expect(toasts[0].alertData?.label).toBe('Impulse')
    expect(toasts[0].alertData?.symbol).toBe('BTC')
    expect(toasts[0].alertData?.accent).toBe('-4.2%')
    expect(toasts[0].alertData?.accentTone).toBe('down')
    expect(toasts[0].alertData?.sub).toBe('Binance Futures')
  })

  it('honors the requested position', () => {
    useToastStore.getState().showAlert(impulseAlert(), { position: 'bottom-left' })
    expect(useToastStore.getState().toasts[0].position).toBe('bottom-left')
  })

  it('builds a price toast with the crossing level', () => {
    useToastStore.getState().showAlert(priceAlert())
    const t = useToastStore.getState().toasts[0]
    expect(t.alertData?.label).toBe('Price alert')
    expect(t.alertData?.accent).toBe('')
    expect(t.alertData?.sub).toBe('3,001.00')
  })

  it('signs and colors the impulse by the candle direction (up)', () => {
    useToastStore.getState().showAlert(impulseAlert({ movePct: 3.2, direction: 'up' }))
    const t = useToastStore.getState().toasts[0]
    expect(t.alertData?.accent).toBe('+3.2%')
    expect(t.alertData?.accentTone).toBe('up')
  })

  it('signs and colors the impulse by the candle direction (down)', () => {
    useToastStore.getState().showAlert(impulseAlert({ movePct: 3.2, direction: 'down' }))
    const t = useToastStore.getState().toasts[0]
    expect(t.alertData?.accent).toBe('-3.2%')
    expect(t.alertData?.accentTone).toBe('down')
  })
})

describe('useToastStore — stacking and caps', () => {
  it('queues multiple toasts in the same corner (oldest first)', () => {
    for (let i = 0; i < 3; i++) {
      useToastStore.getState().showAlert(impulseAlert({ id: `a${i}` }))
    }
    expect(useToastStore.getState().toasts).toHaveLength(3)
  })

  it('drops the oldest toast when the corner queue exceeds 6', () => {
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

describe('useToastStore — single-slot queue', () => {
  it('chains timers: a queued alert auto-dismisses only after it becomes visible', () => {
    vi.useFakeTimers()
    useToastStore.getState().showAlert(impulseAlert({ id: 'a1' }), { duration: 20000 })
    useToastStore.getState().showAlert(impulseAlert({ id: 'a2' }), { duration: 20000 })
    const queuedId = useToastStore.getState().toasts[1].id
    // Only the visible (oldest) toast auto-closes; a2 stays queued.
    vi.advanceTimersByTime(20000)
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useToastStore.getState().toasts[0].id).toBe(queuedId)
    // Once promoted, a2 gets its own full duration.
    vi.advanceTimersByTime(20000)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('manually dismissing the visible toast promotes the next queued one', () => {
    vi.useFakeTimers()
    useToastStore.getState().showAlert(impulseAlert({ id: 'a1' }), { duration: 20000 })
    useToastStore.getState().showAlert(impulseAlert({ id: 'a2' }), { duration: 20000 })
    const firstId = useToastStore.getState().toasts[0].id
    useToastStore.getState().dismiss(firstId)
    const rest = useToastStore.getState().toasts
    expect(rest).toHaveLength(1)
    // The promoted toast's timer starts at promotion time, not creation time.
    vi.advanceTimersByTime(19999)
    expect(useToastStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('dismissAll clears queued alerts and their timers', () => {
    vi.useFakeTimers()
    useToastStore.getState().showAlert(impulseAlert({ id: 'a1' }), { duration: 20000 })
    useToastStore.getState().showAlert(impulseAlert({ id: 'a2' }), { duration: 20000 })
    useToastStore.getState().dismissAll()
    expect(useToastStore.getState().toasts).toHaveLength(0)
    vi.advanceTimersByTime(60000)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
