import { useEffect } from 'react'
import { useDrawingHotkeysStore, eventToCombo, isInputFocused, DRAWING_TOOL_LABELS } from '../store/drawingHotkeys'
import { useUIStore } from '../store'
import { useToastStore } from '../store/toast'

export function useDrawingHotkeys() {
  const activeTool = useDrawingHotkeysStore(s => s.activeTool)
  const bindings = useDrawingHotkeysStore(s => s.bindings)
  const activateTool = useDrawingHotkeysStore(s => s.activateTool)
  const deactivate = useDrawingHotkeysStore(s => s.deactivate)
  const showToast = useToastStore(s => s.show)

  const modalsOpen = useUIStore(s =>
    s.showAuth || s.showProfile || s.showExchangeModal || s.showTickerSearch,
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputFocused()) return
      if (modalsOpen) return
      if (e.repeat) return

      const combo = eventToCombo(e)
      if (!combo) return

      for (const tool of Object.keys(bindings) as Array<keyof typeof bindings>) {
        if (bindings[tool] === combo) {
          e.preventDefault()
          const isActive = activeTool === tool
          if (isActive) {
            deactivate()
            showToast(`${DRAWING_TOOL_LABELS[tool]}: отключен`)
          } else {
            activateTool(tool)
            showToast(`${DRAWING_TOOL_LABELS[tool]}: активен`)
          }
          return
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTool, bindings, activateTool, deactivate, showToast, modalsOpen])
}
