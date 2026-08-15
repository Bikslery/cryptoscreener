import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { getLivePrice, getLivePriceEx, subscribeLivePrice, subscribeLivePriceEx } from '../store'
import {
  registerGlider,
  unregisterGlider,
  beginScalarGlide,
  advanceScalarGlide,
  glideDurationFor,
  type Glider,
} from '../services/glide'
import { formatPrice, snapToTick } from '../utils/format'

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
 * `exchange` (optional) scopes the subscription to the exchange-specific live
 * lane (store's setLivePriceEx) — chart headers pass their chartExchange so
 * the shown price is the exact price painted on THEIR chart, never another
 * venue's last print. Without it the global per-symbol lane is used.
 *
 * Adaptive behavior (glide.ts): live pairs (updates every <=80 ms) SNAP to
 * the new value — a fixed-duration glide restarted by every retarget never
 * converges and visibly chases the market. Quiet symbols glide smoothly over
 * up to ~160 ms. Presentation only — chart data and store state are never
 * touched.
 */
export function useSmoothedPriceRef(
  symbol: string,
  precision: number,
  initialPrice?: number,
  prefix = '',
  exchange?: string,
): RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement | null>(null)
  const precisionRef = useRef(precision)
  const prefixRef = useRef(prefix)
  const initialRef = useRef(initialPrice)
  // Glide state that survives element re-attaches and header re-renders.
  const st = useRef({
    symbol: null as string | null,
    exchange: null as string | null,
    displayed: undefined as number | undefined,
    glide: null as ReturnType<typeof beginScalarGlide> | null,
    lastTargetAt: 0,
  }).current

  const paint = useCallback(() => {
    const el = ref.current
    if (el && st.displayed !== undefined) {
      // Snap to the exchange tick grid so the shown value always exists as a
      // стакан level (a glide mid-flight would otherwise pass through
      // off-grid prices the book cannot display).
      el.textContent = prefixRef.current + formatPrice(snapToTick(st.displayed, precisionRef.current), precisionRef.current)
    }
  }, [st])

  // Exchange-scoped read with a fall back to the global per-symbol lane —
  // before the chart's own lane has its first print the global seed shows.
  const readLive = useCallback(() => {
    if (exchange) return getLivePriceEx(symbol, exchange) ?? getLivePrice(symbol)
    return getLivePrice(symbol)
  }, [symbol, exchange])

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
    // Symbol/exchange switched (ExpandedChart is reused across symbols): reset state.
    if (st.symbol !== symbol || st.exchange !== exchange) {
      st.symbol = symbol
      st.exchange = exchange ?? null
      st.displayed = undefined
      st.glide = null
      st.lastTargetAt = 0
    }

    // First known price: show it immediately — no glide from nothing.
    const seed = readLive() ?? initialRef.current
    if (seed !== undefined && st.displayed === undefined) {
      st.displayed = seed
      st.lastTargetAt = performance.now()
      paint()
    }

    const glider: Glider = {
      tick(dt) {
        const el = ref.current
        const t = readLive()
        const s = st.displayed
        if (!el || !el.isConnected) return false
        if (t === undefined || s === undefined) return false
        const interval = performance.now() - st.lastTargetAt
        if (glideDurationFor(interval) === 0) {
          // Live pair — snap instead of gliding (a restarted glide would
          // chase the market forever). Converge immediately.
          st.glide = null
          st.displayed = t
          el.textContent = prefixRef.current + formatPrice(snapToTick(t, precisionRef.current), precisionRef.current)
          return false
        }
        if (!st.glide) {
          st.glide = beginScalarGlide(s, t, glideDurationFor(interval))
        } else if (st.glide.to !== t) {
          // Retarget mid-glide from the current displayed value.
          st.glide = beginScalarGlide(s, t, glideDurationFor(interval))
        }
        const { next, converged, glide } = advanceScalarGlide(st.glide, dt)
        st.glide = glide
        if (converged) {
          st.glide = null
          st.displayed = t
          el.textContent = prefixRef.current + formatPrice(snapToTick(t, precisionRef.current), precisionRef.current)
          return false
        }
        st.displayed = next
        el.textContent = prefixRef.current + formatPrice(snapToTick(next, precisionRef.current), precisionRef.current)
        return true
      },
    }

    const onPrice = () => {
      const t = readLive()
      if (t === undefined) return
      if (st.displayed === undefined) {
        // First known price — show it immediately, no glide from nothing.
        st.displayed = t
        st.lastTargetAt = performance.now()
        paint()
        return
      }
      const interval = performance.now() - st.lastTargetAt
      st.lastTargetAt = performance.now()
      if (glideDurationFor(interval) === 0) {
        // Live pair: paint the target right now — no rAF round-trip, zero lag.
        st.glide = null
        st.displayed = t
        paint()
        return
      }
      if (st.glide === null) registerGlider(glider)
    }

    const unsub = exchange
      ? subscribeLivePriceEx(symbol, exchange, onPrice)
      : subscribeLivePrice(symbol, onPrice)
    return () => {
      unsub()
      unregisterGlider(glider)
    }
  }, [symbol, exchange, st, paint, readLive])

  return ref
}
