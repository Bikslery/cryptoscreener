import type { UnifiedCandle } from '../types'

export function isFiniteOHLCV(c: { open: number; high: number; low: number; close: number; volume: number }): boolean {
  return isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) && isFinite(c.volume)
}

export function validateCandle(c: UnifiedCandle): boolean {
  if (!isFiniteOHLCV(c)) return false
  if (c.high < c.low) return false
  if (c.high < c.open || c.high < c.close) return false
  if (c.low > c.open || c.low > c.close) return false
  if (c.volume < 0) return false
  if (!c.time || c.time <= 0) return false
  return true
}

export function normalizeCandle<T extends UnifiedCandle>(c: T): T {
  if (!isFiniteOHLCV(c)) return c
  const all = [c.open, c.high, c.low, c.close]
  const h = Math.max(...all)
  const l = Math.min(...all)
  if (c.high === h && c.low === l) return c
  return { ...c, high: h, low: l }
}

/**
 * Cap for client-side period-jump bridging at the LIVE EDGE only: beyond this
 * many missing periods nothing is synthesized and the jump escalates to a
 * full history reload. History itself is NEVER fabricated — see
 * sanitizeCandles.
 */
export const MAX_FORWARD_FILL_PERIODS = 120

/**
 * Flat bridge bars for a live period jump: anchored to the previous close,
 * volume 0, marked final. The caller paints them right before the incoming
 * bar so lightweight-charts never inserts whitespace between the tail and
 * the new bar; a targeted range backfill then swaps them for real rows.
 *
 * These are a TRANSIENT right-edge patch ONLY (seconds, until real rows
 * arrive). They must never be fed into history painting — the server heals
 * its cache with REAL exchange rows and the client paints exactly that.
 */
export function forwardFillGap(
  lastBar: UnifiedCandle,
  incomingTime: number,
  tfSec: number,
): UnifiedCandle[] {
  const periods = Math.round((incomingTime - lastBar.time) / tfSec)
  if (!(periods > 1)) return []
  const missing = Math.min(periods - 1, MAX_FORWARD_FILL_PERIODS)
  const fillers: UnifiedCandle[] = []
  for (let i = 1; i <= missing; i++) {
    fillers.push({
      ...lastBar,
      time: lastBar.time + i * tfSec,
      open: lastBar.close,
      high: lastBar.close,
      low: lastBar.close,
      close: lastBar.close,
      volume: 0,
      isFinal: true,
    })
  }
  return fillers
}

/** A synthetic bridge bar produced by forwardFillGap / tick-opened bars
 *  (flat, zero volume). */
export function isFlatFiller(c: UnifiedCandle): boolean {
  return c.volume === 0 && c.open === c.high && c.high === c.low && c.low === c.close
}

/**
 * Normalize ANY candle array into a safe-to-paint series:
 *   1. drop candles failing validateCandle (NaN/negative/inverted OHLC),
 *   2. clamp high = max(o,h,l,c), low = min(o,h,l,c),
 *   3. dedupe by time — the LAST occurrence wins (newest source of truth),
 *   4. sort strictly ascending.
 *
 * Unlike the old contiguify() it NEVER fabricates rows: mid-history holes
 * render as whitespace until the server serves healed, complete history —
 * fake flat dojis painted over untraded periods were exactly the "broken
 * candle" artifact this replaces.
 *
 * Returns the input by reference when already clean (hot path).
 */
export function sanitizeCandles(candles: UnifiedCandle[]): UnifiedCandle[] {
  let needsWork = false
  const seen = new Set<number>()
  for (const c of candles) {
    if (seen.has(c.time)) { needsWork = true; break }
    seen.add(c.time)
    if (!validateCandle(c)) { needsWork = true; break }
  }
  if (!needsWork) return candles

  const byTime = new Map<number, UnifiedCandle>()
  for (const c of candles) {
    if (!validateCandle(c)) continue
    // Last write wins: when two sources disagree on one timestamp the newer
    // input (live kline / fresher REST page) replaces the stale row.
    byTime.set(c.time, normalizeCandle(c))
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time)
}

/**
 * Merge a freshly loaded series INTO the currently painted one without
 * regression. lightweight-charts is append/replace-only: a setData() whose
 * last bar is OLDER than what is already on screen silently erases those
 * newer bars — the classic "tail teleports backwards, then the next kline
 * bridges the vanished minutes with flat placeholders" bug.
 *
 * Rules:
 *   - union by time, both inputs sorted ascending;
 *   - `incoming` wins collisions (fresher server snapshot);
 *   - bars that exist only in `current` survive — including everything
 *     NEWER than the incoming tail (painted live klines are never lost);
 *   - O(n + m), output sorted ascending.
 */
export function mergeCandleSeries(current: UnifiedCandle[], incoming: UnifiedCandle[]): UnifiedCandle[] {
  if (incoming.length === 0) return current
  if (current.length === 0) return incoming

  const out: UnifiedCandle[] = []
  let i = 0
  let j = 0
  while (i < current.length && j < incoming.length) {
    const a = current[i]
    const b = incoming[j]
    if (a.time < b.time) { out.push(a); i++ }
    else if (a.time > b.time) { out.push(b); j++ }
    else { out.push(b); i++; j++ }
  }
  while (i < current.length) { out.push(current[i]); i++ }
  while (j < incoming.length) { out.push(incoming[j]); j++ }
  return out
}
