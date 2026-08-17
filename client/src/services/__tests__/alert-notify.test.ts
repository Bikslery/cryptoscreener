import { describe, it, expect, vi, afterEach } from 'vitest'
import { notifyNewAlert, playAlertSound, initAlertNotifications } from '../alert-notify'
import type { Alert } from '../../types'

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1',
    userId: 'u1',
    type: 'price',
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    condition: { price: 65000, direction: 'above' },
    price: 65100,
    active: false,
    muted: false,
    triggeredAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('alert-notify — sound + native notifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a native notification with title/body/tag when permission granted', () => {
    const created: Array<{ title: string; options: NotificationOptions }> = []
    vi.stubGlobal('Notification', class {
      static permission: NotificationPermission = 'granted'
      title: string
      options: NotificationOptions
      onclick: (() => void) | null = null
      constructor(title: string, options: NotificationOptions) {
        this.title = title
        this.options = options
        created.push({ title, options })
      }
      close() {}
    })
    notifyNewAlert(makeAlert())
    expect(created).toHaveLength(1)
    expect(created[0].title).toContain('BTC')
    expect(created[0].options.body).toContain('Price cross')
    expect(created[0].options.body).toContain('65,100')
    expect(created[0].options.tag).toBe('serotonin-alert-a1')
  })

  it('does not create a notification when permission is denied', () => {
    let constructed = 0
    vi.stubGlobal('Notification', class {
      static permission: NotificationPermission = 'denied'
      constructor() { constructed++ }
      close() {}
    })
    notifyNewAlert(makeAlert())
    expect(constructed).toBe(0)
  })

  it('is a no-op without the Notification API', () => {
    vi.stubGlobal('Notification', undefined)
    expect(() => notifyNewAlert(makeAlert())).not.toThrow()
  })

  it('sound is best-effort without WebAudio', () => {
    // jsdom has no AudioContext — must silently no-op.
    expect(() => playAlertSound()).not.toThrow()
  })

  it('requests notification permission on the first user gesture', () => {
    let asked = 0
    vi.stubGlobal('Notification', class {
      static permission: NotificationPermission = 'default'
      static requestPermission() { asked++; return Promise.resolve('granted' as NotificationPermission) }
      constructor() {}
      close() {}
    })
    initAlertNotifications()
    window.dispatchEvent(new Event('pointerdown'))
    expect(asked).toBe(1)
    // Second gesture must not re-ask (once:true + permission already requested).
    window.dispatchEvent(new Event('pointerdown'))
    expect(asked).toBe(1)
  })
})
