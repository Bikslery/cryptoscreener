import { create } from 'zustand'
import type { Alert } from '../types'
import { formatPrice, extractBaseAsset } from '../utils/format'

export type ToastPosition = 'bottom-center' | 'bottom-right' | 'bottom-left'

export interface AlertToastData {
  type: Alert['type']
  /** Header label: Импульс / Пересечение цены / Листинг. */
  label: string
  /** Big mono ticker. */
  symbol: string
  /** Colored suffix next to the ticker (movement % for impulse). */
  accent: string
  accentTone: 'up' | 'down' | 'neutral'
  /** Details line under the ticker. */
  sub: string
}

interface Toast {
  id: number
  kind: 'message' | 'alert'
  message: string
  duration: number
  position: ToastPosition
  alertData?: AlertToastData
}

interface ToastState {
  toasts: Toast[]
  show: (message: string, duration?: number) => void
  showAlert: (alert: Alert, opts?: { position?: 'bottom-right' | 'bottom-left'; duration?: number }) => void
  dismiss: (id: number) => void
  dismissAll: () => void
}

const ALERT_LABELS: Record<string, string> = {
  price: 'Price alert',
  impulse: 'Impulse',
  listing: 'Listing',
}

const EXCHANGE_NAMES: Record<string, string> = {
  'binance-futures': 'Binance Futures',
  'binance-spot': 'Binance Spot',
  'bybit-futures': 'Bybit Futures',
  'okx-spot': 'OKX Spot',
  'okx-futures': 'OKX Futures',
}

const DEFAULT_ALERT_DURATION_MS = 20_000
/** Soft cap per corner — oldest queued alert toasts drop off when the queue overflows. */
const ALERT_STACK_LIMIT = 6
/** Alert corners render one toast at a time; everything else waits in the queue. */
const ALERT_POSITIONS: ToastPosition[] = ['bottom-right', 'bottom-left']

let toastId = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function buildAlertData(alert: Alert): AlertToastData {
  const symbol = extractBaseAsset(alert.symbol) || 'ANY'
  const exchangeName = alert.exchange ? EXCHANGE_NAMES[alert.exchange] ?? alert.exchange : ''
  if (alert.type === 'impulse') {
    const cond = alert.condition as { percent?: number }
    const move = typeof alert.movePct === 'number' ? alert.movePct : cond.percent ?? 0
    // The engine sends the candle direction; legacy payloads fall back to the
    // move sign. movePct is an unsigned range, so the sign NEVER comes from it.
    const dir = alert.direction
    const tone: AlertToastData['accentTone'] = dir === 'down' ? 'down' : dir === 'up' ? 'up' : move < 0 ? 'down' : 'up'
    const sign = dir === 'down' ? '-' : dir === 'up' ? '+' : ''
    const displayed = dir ? Math.abs(move).toFixed(1) : move.toFixed(1)
    return {
      type: 'impulse',
      label: ALERT_LABELS.impulse,
      symbol,
      accent: `${sign}${displayed}%`,
      accentTone: tone,
      sub: exchangeName,
    }
  }
  if (alert.type === 'price') {
    const cond = alert.condition as { price?: number }
    const priceText = alert.price != null ? alert.price : cond.price ?? 0
    return {
      type: 'price',
      label: ALERT_LABELS.price,
      symbol,
      accent: '',
      accentTone: 'neutral',
      sub: formatPrice(priceText, 2),
    }
  }
  return {
    type: 'listing',
    label: ALERT_LABELS.listing,
    symbol,
    accent: '',
    accentTone: 'neutral',
    sub: exchangeName || 'New listing',
  }
}

function pruneAlertStack(toasts: Toast[], position: ToastPosition, limit: number): Toast[] {
  const ids = toasts.filter(t => t.kind === 'alert' && t.position === position).map(t => t.id)
  if (ids.length <= limit) return toasts
  const drop = new Set(ids.slice(0, ids.length - limit))
  for (const id of drop) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }
  return toasts.filter(t => !drop.has(t.id))
}

function scheduleDismiss(id: number, duration: number) {
  timers.set(id, setTimeout(() => {
    timers.delete(id)
    useToastStore.getState().dismiss(id)
  }, duration))
}

/**
 * Only the oldest queued alert of each corner is visible, so it is the only
 * one with an auto-dismiss timer. When it closes (timer or manual), the next
 * queued toast gets promoted here and its timer starts fresh.
 */
function syncTimers(toasts: Toast[]) {
  for (const position of ALERT_POSITIONS) {
    const first = toasts.find(t => t.kind === 'alert' && t.position === position)
    if (first && !timers.has(first.id)) {
      scheduleDismiss(first.id, first.duration)
    }
  }
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, duration = 2000) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, kind: 'message', message, duration, position: 'bottom-center' }] }))
    scheduleDismiss(id, duration)
  },
  showAlert: (alert, opts = {}) => {
    const id = ++toastId
    const position = opts.position ?? 'bottom-right'
    const duration = opts.duration ?? DEFAULT_ALERT_DURATION_MS
    set((s) => {
      const next: Toast[] = [...s.toasts, {
        id,
        kind: 'alert',
        message: ALERT_LABELS[alert.type] ?? 'Алерт',
        duration,
        position,
        alertData: buildAlertData(alert),
      }]
      const pruned = pruneAlertStack(next, position, ALERT_STACK_LIMIT)
      return { toasts: pruned }
    })
    syncTimers(useToastStore.getState().toasts)
  },
  dismiss: (id) => {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    syncTimers(useToastStore.getState().toasts)
  },
  dismissAll: () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    set({ toasts: [] })
  },
}))
