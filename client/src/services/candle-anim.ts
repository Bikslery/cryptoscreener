/**
 * Forming-candle animation math (scalpboard-style smooth price motion).
 *
 * The forming candle's body should GLIDE toward the new price instead of
 * teleporting. The backing array keeps the exact authoritative values; the
 * renderer interpolates the last bar's OHLC toward them on each animation
 * frame via exponential smoothing, so the body stretches/slides smoothly and
 * converges in ~100ms. Purely presentation — no data is ever modified.
 */

export interface FormingTarget {
  time: number
  open: number
  high: number
  low: number
  close: number
}

/**
 * One interpolation step. `k` is the per-step convergence factor (0..1]:
 * higher = faster. Returns the next displayed values and whether they have
 * converged onto the target (within a close-relative epsilon).
 */
export function stepFormingAnimation(
  displayed: FormingTarget,
  target: FormingTarget,
  k: number,
): { next: FormingTarget; converged: boolean } {
  const next: FormingTarget = {
    time: target.time,
    open: displayed.open + (target.open - displayed.open) * k,
    high: displayed.high + (target.high - displayed.high) * k,
    low: displayed.low + (target.low - displayed.low) * k,
    close: displayed.close + (target.close - displayed.close) * k,
  }
  const eps = Math.max(Math.abs(target.close) * 1e-6, 1e-9)
  const converged =
    Math.abs(next.close - target.close) < eps &&
    Math.abs(next.high - target.high) < eps &&
    Math.abs(next.low - target.low) < eps &&
    Math.abs(next.open - target.open) < eps
  return { next, converged }
}

/**
 * Frame-rate-independent per-frame factor: `k60` at 60 Hz yields the same
 * convergence time on any display. A 120 Hz monitor runs twice as many steps
 * per second, so each step uses a smaller k and the glide still converges in
 * ~100 ms — identical to the time-based easing in glide.ts.
 */
export function formingGlideK(dtMs: number, k60 = 0.45): number {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 16.7
  return 1 - Math.pow(1 - k60, dt / 16.7)
}
