import { create } from 'zustand'
import type { Alert } from '../types'
import { formatPrice, extractBaseAsset } from '../utils/format'

export type ToastPosition = 'bottom-center' | 'bottom-right' | 'bottom-left'

export interface AlertToastData {
  type: Alert['type']
  symbol: string
  /** Details line: movement % / price crossing / exchange. */
  line: string
  tone: 'up' | 'down' | 'neutral'
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
  price: 'Цена',
  impulse: 'Импульс',
  listing: 'Листинг',
}

const DEFAULT_ALERT_DURATION_MS = 20_000
/** Soft cap per corner — older alert toasts drop off when the stack overflows. */
const ALERT_STACK_LIMIT = 6

let toastId = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function buildAlertData(alert: Alert): AlertToastData {
  const symbol = extractBaseAsset(alert.symbol) || 'ANY'
  if (alert.type === 'impulse') {
    const cond = alert.condition as { timeframe?: string; direction?: string; volumeSpike?: number; percent?: number }
    const dir = cond.direction === 'up' ? 'вверх' : cond.direction === 'down' ? 'вниз' : 'любое'
    const move = typeof alert.movePct === 'number' ? alert.movePct : cond.percent ?? 0
    const sign = move >= 0 ? '+' : ''
    const vol = (cond.volumeSpike ?? 0) > 0 ? ` · об ×${cond.volumeSpike}` : ''
    const tone = cond.direction === 'up' ? 'up' : cond.direction === 'down' ? 'down' : (move >= 0 ? 'up' : 'down')
    return {
      type: 'impulse',
      symbol,
      line: `${sign}${move.toFixed(1)}% · ${cond.timeframe ?? '5m'} ${dir}${vol}`,
      tone: tone as AlertToastData['tone'],
    }
  }
  if (alert.type === 'price') {
    const cond = alert.condition as { price?: number; direction?: string }
    const priceText = alert.price != null ? `$${formatPrice(alert.price, 2)}` : `$${formatPrice(cond.price ?? 0, 2)}`
    const dirText = cond.direction === 'above' ? 'выше' : 'ниже'
    return { type: 'price', symbol, line: `${priceText} ${dirText}`, tone: 'neutral' }
  }
  return { type: 'listing', symbol, line: alert.exchange ?? '', tone: 'neutral' }
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
      return { toasts: pruneAlertStack(next, position, ALERT_STACK_LIMIT) }
    })
    scheduleDismiss(id, duration)
  },
  dismiss: (id) => {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  dismissAll: () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    set({ toasts: [] })
  },
}))
