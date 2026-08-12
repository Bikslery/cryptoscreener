import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { getLivePrice, subscribeLivePrice } from '../store'
import {
  registerGlider,
  unregisterGlider,
  beginScalarGlide,
  advanceScalarGlide,
  glideDurationFor,
  type Glider,
} from '../services/glide'
import { formatPrice } from '../utils/format'

/**
 * Gliding price text — direct DOM updates, zero React re-renders per frame.
 *
 * Subscribes to the symbol's live price IMPERATIVELY (no useSyncExternalStore,
 * no setState) and glides the displayed value toward it on the SHARED rAF
 * coordinator, writing `prefix + formatted price` straight into the attached
 * span's textContent. The component never re-renders because of the price —
 * the digits move purely in the DOM. This is the same mechanic as the coin
 * list's LivePriceCell, but as a hook so any header can use it.
 *
 * Adaptive duration (glide.ts): active symbols converge in ~45 ms (never lag
 * the market), quiet symbols glide smoothly over ~160 ms. Presentation only —
 * chart data and store state are never touched.
 */
export function useSmoothedPriceRef(
  symbol: string,
  precision: number,
  initialPrice?: number,
  prefix = '',
): RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement | null>(null)
  const precisionRef = useRef(precision)
  const prefixRef = useRef(prefix)
  const initialRef = useRef(initialPrice)
  // Glide state that survives element re-attaches and header re-renders.
  const st = useRef({
    symbol: null as string | null,
    displayed: undefined as number | undefined,
    glide: null as ReturnType<typeof beginScalarGlide> | null,
    lastTargetAt: 0,
  }).current

  const paint = useCallback(() => {
    const el = ref.current
    if (el && st.displayed !== undefined) {
      el.textContent = prefixRef.current + formatPrice(st.displayed, precisionRef.current)
    }
  }, [st])

  useEffect(() => {
    precisionRef.current = precision
    prefixRef.current = prefix
    // Re-render with a new precision/prefix should re-format what's shown.
    paint()
  }, [precision, prefix, paint])

  // Seed from the coin's static price when it loads late (before the first
  // live frame for this symbol arrives). Guarded by the symbol check so a
  // symbol switch can never leak the previous symbol's price in.
  useEffect(() => {
    if (st.symbol === symbol && st.displayed === undefined && initialPrice !== undefined) {
      st.displayed = initialPrice
      st.lastTargetAt = performance.now()
      paint()
    }
  }, [initialPrice, symbol, paint, st])

  useEffect(() => {
    // Symbol switched (ExpandedChart is reused across symbols): reset state.
    if (st.symbol !== symbol) {
      st.symbol = symbol
      st.displayed = undefined
      st.glide = null
      st.lastTargetAt = 0
    }

    // First known price: show it immediately — no glide from nothing.
    const seed = getLivePrice(symbol) ?? initialRef.current
    if (seed !== undefined && st.displayed === undefined) {
      st.displayed = seed
      st.lastTargetAt = performance.now()
      paint()
    }

    const glider: Glider = {
      tick(dt) {
        const el = ref.current
        const t = getLivePrice(symbol)
        const s = st.displayed
        if (!el || !el.isConnected) return false
        if (t === undefined || s === undefined) return false
        if (!st.glide) {
          st.glide = beginScalarGlide(s, t, glideDurationFor(performance.now() - st.lastTargetAt))
        } else if (st.glide.to !== t) {
          // Retarget mid-glide from the current displayed value.
          st.glide = beginScalarGlide(s, t, glideDurationFor(performance.now() - st.lastTargetAt))
        }
        const { next, converged, glide } = advanceScalarGlide(st.glide, dt)
        st.glide = glide
        if (converged) {
          st.glide = null
          st.displayed = t
          el.textContent = prefixRef.current + formatPrice(t, precisionRef.current)
          return false
        }
        st.displayed = next
        el.textContent = prefixRef.current + formatPrice(next, precisionRef.current)
        return true
      },
    }

    const onPrice = () => {
      const t = getLivePrice(symbol)
      if (t === undefined) return
      if (st.displayed === undefined) {
        // First known price — show it immediately, no glide from nothing.
        st.displayed = t
        st.lastTargetAt = performance.now()
        paint()
        return
      }
      st.lastTargetAt = performance.now()
      if (st.glide === null) registerGlider(glider)
    }

    const unsub = subscribeLivePrice(symbol, onPrice)
    return () => {
      unsub()
      unregisterGlider(glider)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, st, paint])

  return ref
}
