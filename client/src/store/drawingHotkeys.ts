import { create } from 'zustand'
import type { DrawingTool } from '../types.js'
import { useAuthStore } from './index.js'
import { getEnglishLetterFromKeyCode } from '../utils/keyboard.js'

export const DEFAULT_DRAWING_HOTKEYS: Record<DrawingTool, string> = {
  'h-ray': 'shift+d',
  't-ray': 'shift+s',
  segment: 'shift+a',
}

export const DRAWING_TOOL_LABELS: Record<DrawingTool, string> = {
  'h-ray': 'Горизонтальный луч',
  't-ray': 'Трендовый луч',
  segment: 'Отрезок',
}

interface DrawingHotkeysState {
  bindings: Record<DrawingTool, string>
  activeTool: DrawingTool | null

  initFromSettings: (settings?: { drawingHotkeys?: Record<DrawingTool, string> }) => void
  setBindings: (bindings: Record<DrawingTool, string>) => Promise<void>
  setBinding: (tool: DrawingTool, combo: string) => Promise<void>
  resetDefaults: () => Promise<void>
  activateTool: (tool: DrawingTool | null) => void
  deactivate: () => void
  toggleTool: (tool: DrawingTool) => void
}

export function normalizeCombo(combo: string): string {
  return combo
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('+')
    .sort((a, b) => {
      const order: Record<string, number> = { ctrl: 0, alt: 1, shift: 2, meta: 3 }
      const ao = order[a] ?? 100
      const bo = order[b] ?? 100
      return ao - bo
    })
    .join('+')
}

export function formatCombo(combo: string): string {
  const parts = normalizeCombo(combo).split('+')
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('+')
}

export function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')

  // Use e.code (physical key position, layout-independent) for letters so
  // hotkeys work on any keyboard layout. On Russian layout, pressing the
  // physical D key gives e.key='д' but e.code='KeyD' — without this, the
  // combo would never match the English-letter binding stored in settings.
  const letter = getEnglishLetterFromKeyCode(e.code)
  if (letter) {
    parts.push(letter.toLowerCase())
  } else {
    // Non-letter keys (digits, F-keys, punctuation): use e.key as-is.
    const key = e.key.toLowerCase()
    if (key && !['control', 'alt', 'shift', 'meta'].includes(key)) {
      parts.push(key)
    }
  }

  return normalizeCombo(parts.join('+'))
}

export function isInputFocused(): boolean {
  const active = document.activeElement as HTMLElement | null
  if (!active) return false
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable
}

export const useDrawingHotkeysStore = create<DrawingHotkeysState>((set, get) => ({
  bindings: { ...DEFAULT_DRAWING_HOTKEYS },
  activeTool: null,

  initFromSettings: (settings) => {
    const merged: Record<DrawingTool, string> = { ...DEFAULT_DRAWING_HOTKEYS }
    if (settings?.drawingHotkeys) {
      for (const tool of Object.keys(DEFAULT_DRAWING_HOTKEYS) as DrawingTool[]) {
        const value = settings.drawingHotkeys[tool]
        if (typeof value === 'string') {
          merged[tool] = normalizeCombo(value)
        }
      }
    }
    set({ bindings: merged })
  },

  setBindings: async (bindings) => {
    const normalized: Record<DrawingTool, string> = { ...DEFAULT_DRAWING_HOTKEYS }
    for (const tool of Object.keys(DEFAULT_DRAWING_HOTKEYS) as DrawingTool[]) {
      normalized[tool] = normalizeCombo(bindings[tool] ?? '')
    }
    set({ bindings: normalized })
    await persistHotkeys(normalized)
  },

  setBinding: async (tool, combo) => {
    const { bindings } = get()
    const normalized = normalizeCombo(combo)
    const next = { ...bindings, [tool]: normalized }
    set({ bindings: next })
    await persistHotkeys(next)
  },

  resetDefaults: async () => {
    set({ bindings: { ...DEFAULT_DRAWING_HOTKEYS } })
    await persistHotkeys({ ...DEFAULT_DRAWING_HOTKEYS })
  },

  activateTool: (tool) => set({ activeTool: tool }),

  deactivate: () => set({ activeTool: null }),

  toggleTool: (tool) => {
    const { activeTool } = get()
    set({ activeTool: activeTool === tool ? null : tool })
  },
}))

async function persistHotkeys(bindings: Record<DrawingTool, string>) {
  const authState = useAuthStore.getState()
  if (!authState.isLoggedIn) return
  const settings = { ...(authState.settings ?? {}), drawingHotkeys: bindings }
  await authState.updateSettings(settings)
}
