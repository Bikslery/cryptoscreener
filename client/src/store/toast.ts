import { create } from 'zustand'

interface Toast {
  id: number
  message: string
  duration: number
}

interface ToastState {
  toasts: Toast[]
  show: (message: string, duration?: number) => void
  dismiss: (id: number) => void
}

let toastId = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, duration = 2000) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, message, duration }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, duration)
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
