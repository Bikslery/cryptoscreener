import { useEffect, useRef, useState } from 'react'
import { useLivePrice } from '../store'
import {
  registerGlider,
  unregisterGlider,
  beginScalarGlide,
  advanceScalarGlide,
  glideDurationFor,
  type Glider,
} from '../services/glide'

/**
 * Smooth price display (scalpboard-style ticker feel).
 *
 * The raw live price jumps discretely — once a second on quiet symbols, which
 * reads as "jerky". This hook glides the DISPLAYED value toward the live value
 * with TIME-BASED easing on the SHARED rAF coordinator (glide.ts): the same
 * frame loop that drives the forming-candle animators also drives every header
 * price, so timing is consistent and there is exactly one rAF per page, not
 * one per component.
 *
 * The glide duration adapts to update frequency — active symbols converge in
 * ~45 ms (never lag the market), quiet symbols glide smoothly over ~160 ms.
 *
 * Presentation only: chart data and store state are never touched — only the
 * number rendered in a header.
 */
export function useSmoothedPrice(symbol: string): number | undefined {
  const target = useLivePrice(symbol)
  const [shown, setShown] = useState<number | undefined>(undefined)
  const shownRef = useRef<number | undefined>(undefined)
  const targetRef = useRef<number | undefined>(target)
  const lastTargetAtRef = useRef(0)
  const glideRef = useRef<ReturnType<typeof beginScalarGlide> | null>(null)

  useEffect(() => {
    if (targetRef.current !== target) {
      targetRef.current = target
      lastTargetAtRef.current = performance.now()
    }
  }, [target])

  useEffect(() => {
    // First known price: show it immediately — no glide from nothing.
    if (shownRef.current === undefined && target !== undefined) {
      shownRef.current = target
      setShown(target)
      return
    }

    const glider: Glider = {
      tick(dt) {
        const t = targetRef.current
        const s = shownRef.current
        if (t === undefined || s === undefined) return false
        if (!glideRef.current) {
          glideRef.current = beginScalarGlide(
            s, t,
            glideDurationFor(performance.now() - lastTargetAtRef.current),
          )
        } else if (glideRef.current.to !== t) {
          // Retarget mid-glide: re-base from the current displayed value
          // toward the new target (frequent updates → short duration).
          glideRef.current = beginScalarGlide(
            s, t,
            glideDurationFor(performance.now() - lastTargetAtRef.current),
          )
        }
        const { next, converged, glide } = advanceScalarGlide(glideRef.current, dt)
        glideRef.current = glide
        if (converged) {
          glideRef.current = null
          shownRef.current = t
          setShown(t)
          return false
        }
        shownRef.current = next
        setShown(next)
        return true
      },
    }
    registerGlider(glider)
    return () => unregisterGlider(glider)
  }, [target])

  return shown
}
