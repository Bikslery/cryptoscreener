/**
 * Shared glide engine: time-based easing + ONE rAF coordinator for all
 * price/candle glides.
 *
 * Before this module, every gliding surface ran its OWN requestAnimationFrame
 * loop with a per-frame factor — the convergence speed depended on the
 * monitor's refresh rate (120 Hz glided twice as fast as 60 Hz) and dropped
 * frames turned into jerks. Here the easing is time-based (fixed duration,
 * easeOutCubic), so the glide looks identical on any hardware, and every
 * glider registers with a single coordinator that advances all of them in one
 * pass per animation frame — no per-surface loops, consistent timing.
 *
 * Pure math + one tiny rAF scheduler. No React, no data mutation: gliders
 * only interpolate what gets PAINTED.
 */

/** easeOutCubic — starts fast, decelerates into the target. */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - x, 3)
}

/** Longest glide for a quiet symbol (big jump after a pause). */
export const GLIDE_DURATION_MAX = 160
/** Shortest glide — updates that frequent but not live (interval > SNAP). */
export const GLIDE_DURATION_MIN = 45
/**
 * Updates this frequent mean the pair is LIVE. Every retarget restarts the
 * glide from the current displayed value, so a fixed-duration glide on a
 * frequent feed never converges — the display chases the market forever.
 * Below this interval the display SNAPS to the target instead (duration 0).
 */
export const GLIDE_SNAP_INTERVAL_MS = 80

/**
 * Adaptive glide duration from the time since the last target change.
 * Frequent updates (interval ~20–80 ms on active pairs) → duration 0: the
 * display snaps, so it can never lag the market; quiet symbols (updates
 * every second or two) → long smooth glide. One constant multiplier, easy
 * to retune.
 */
export function glideDurationFor(updateIntervalMs: number): number {
  if (!Number.isFinite(updateIntervalMs) || updateIntervalMs <= 0) return GLIDE_DURATION_MAX
  if (updateIntervalMs <= GLIDE_SNAP_INTERVAL_MS) return 0
  return Math.min(GLIDE_DURATION_MAX, Math.max(GLIDE_DURATION_MIN, updateIntervalMs * 1.5))
}

/** One scalar glide: from → to over `duration` ms (elapsed advances by dt). */
export interface ScalarGlide {
  from: number
  to: number
  elapsed: number
  duration: number
}

export function beginScalarGlide(from: number, to: number, duration: number): ScalarGlide {
  return { from, to, elapsed: 0, duration }
}

/** Advance a scalar glide by dt (ms). `converged` = elapsed passed duration.
 *  A zero-duration glide (live pair) converges on its first step. */
export function advanceScalarGlide(
  g: ScalarGlide,
  dt: number,
): { next: number; converged: boolean; glide: ScalarGlide } {
  const elapsed = g.elapsed + dt
  const p = g.duration <= 0 ? 1 : easeOutCubic(elapsed / g.duration)
  const next = g.from + (g.to - g.from) * p
  const converged = elapsed >= g.duration
  return { next, converged, glide: { ...g, elapsed } }
}

// ---------------------------------------------------------------------------
// Shared rAF coordinator
// ---------------------------------------------------------------------------

/**
 * A glider is anything that wants to advance once per animation frame.
 * `tick(dt)` returns false when the glide has converged (or should stop) —
 * the coordinator then unregisters it.
 */
export interface Glider {
  tick(dt: number): boolean
}

const gliders = new Set<Glider>()
let rafId: number | null = null
let lastNow = 0

function frame(now: number) {
  rafId = null
  // dt between frames; clamp so a backgrounded tab doesn't teleport the glide.
  // Baseline comes ONLY from the rAF clock — never mix it with
  // performance.now(), whose clock can be offset from the rAF timestamp
  // (jsdom does this), which produced a huge negative first dt.
  const dt = lastNow === 0 ? 16.7 : Math.min(100, Math.max(0, now - lastNow))
  lastNow = now
  for (const g of [...gliders]) {
    if (!g.tick(dt)) gliders.delete(g)
  }
  if (gliders.size > 0) rafId = requestAnimationFrame(frame)
}

/** Register a glider; starts the (single) shared loop if it isn't running. */
export function registerGlider(g: Glider): void {
  gliders.add(g)
  if (rafId === null) {
    lastNow = 0
    rafId = requestAnimationFrame(frame)
  }
}

/** Unregister a glider; stops the shared loop when the last one leaves. */
export function unregisterGlider(g: Glider): void {
  gliders.delete(g)
  if (gliders.size === 0 && rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
    lastNow = 0
  }
}
