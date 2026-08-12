import { useEffect, useRef, useState } from 'react'
import { useLivePrice } from '../store'

/**
 * Smooth price display (scalpboard-style ticker feel).
 *
 * The raw live price jumps discretely — once a second on quiet symbols, which
 * reads as "jerky". This hook glides the DISPLAYED value toward the live value
 * with exponential smoothing, so digits move continuously instead of snapping.
 *
 * Presentation only: chart data and store state are never touched — only the
 * number rendered in a header. Fast-moving symbols converge in a few frames
 * (~100ms), so the shown price never meaningfully lags; quiet symbols glide
 * smoothly between updates.
 */
export function useSmoothedPrice(symbol: string, factor = 0.5): number | undefined {
  const target = useLivePrice(symbol)
  const [shown, setShown] = useState<number | undefined>(undefined)
  const shownRef = useRef<number | undefined>(undefined)
  const targetRef = useRef<number | undefined>(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    targetRef.current = target
  }, [target])

  useEffect(() => {
    // First known price: show it immediately — no glide from nothing.
    if (shownRef.current === undefined && target !== undefined) {
      shownRef.current = target
      setShown(target)
      return
    }
    if (rafRef.current !== null) return
    const tick = () => {
      rafRef.current = null
      const t = targetRef.current
      const s = shownRef.current
      if (t === undefined || s === undefined) return
      const next = s + (t - s) * factor
      if (Math.abs(t - next) <= Math.max(t * 1e-6, 1e-9)) {
        shownRef.current = t
        setShown(t)
        return
      }
      shownRef.current = next
      setShown(next)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [target, factor])

  return shown
}
