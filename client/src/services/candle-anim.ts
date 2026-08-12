/**
 * Forming-candle glide math (scalpboard-style smooth price motion).
 *
 * The forming candle's body should GLIDE toward the new price instead of
 * teleporting — and so should its VOLUME (a trade adding 5 lots must ease the
 * histogram bar up, not jump it). The backing array keeps the exact
 * authoritative values; the renderer interpolates the last bar's OHLC+volume
 * toward them with TIME-BASED easing (easeOutCubic over a fixed duration —
 * see glide.ts), so the body stretches/slides smoothly and converges in a
 * duration that adapts to how often the price updates. Purely presentation —
 * no data is ever modified.
 */

import { easeOutCubic } from './glide'

export interface FormingTarget {
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Forming-bar volume — glided the same way as OHLC. */
  volume: number
}

/** One forming-candle glide: displayed values easing toward the target. */
export interface FormingGlide {
  from: FormingTarget
  to: FormingTarget
  elapsed: number
  duration: number
}

export function beginFormingGlide(
  from: FormingTarget,
  to: FormingTarget,
  duration: number,
): FormingGlide {
  return { from, to, elapsed: 0, duration }
}

/**
 * Advance a forming glide by dt (ms). Returns the next displayed values,
 * whether they have converged onto the target (elapsed passed duration), and
 * the updated glide state. Every component (OHLC + volume) eases with the
 * same progress — the bar stays coherent, time is pinned to the target
 * (never glides across periods), and nothing ever overshoots (easeOutCubic
 * is monotonic).
 */
export function advanceFormingGlide(
  g: FormingGlide,
  dt: number,
): { next: FormingTarget; converged: boolean; glide: FormingGlide } {
  const elapsed = g.elapsed + dt
  const p = easeOutCubic(elapsed / g.duration)
  const next: FormingTarget = {
    time: g.to.time,
    open: g.from.open + (g.to.open - g.from.open) * p,
    high: g.from.high + (g.to.high - g.from.high) * p,
    low: g.from.low + (g.to.low - g.from.low) * p,
    close: g.from.close + (g.to.close - g.from.close) * p,
    volume: g.from.volume + (g.to.volume - g.from.volume) * p,
  }
  const converged = elapsed >= g.duration
  return { next, converged, glide: { ...g, elapsed } }
}
