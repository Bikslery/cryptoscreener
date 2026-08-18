/** Diagnostics for the "empty places instead of candles" investigation.
 *  Diagnostics ONLY — never touches chart data or rendering.
 *
 *  Two observation surfaces:
 *    1. Counters + a bounded event ring, exposed on `window.__candleDiag`
 *       for browser-console inspection of the open session; and
 *    2. throttled console.warn lines per event kind.
 *
 *  Kind keys are read at the browser console via `__candleDiag.inspect()`;
 *  server-side equivalents live under `/api/debug/candle-stats` and
 *  `/api/debug/ws-stats`.
 */

export interface DiagEvent {
  ts: number
  kind: string
  symbol?: string
  exchange?: string
  tf?: string
  from?: number
  to?: number
  periods?: number
  detail?: string
}

const counters: Record<string, number> = {}
const events: DiagEvent[] = []
const lastLoggedAt: Record<string, number> = {}
const MAX_EVENTS = 200
const THROTTLE_MS = 5000

/** Kinds that always log (not throttled) — the high-signal hole sources. */
const ALWAYS_LOG_KINDS = new Set([
  'gap_not_backfilled',
  'backfill_failed',
  'ws_frame_queue_error',
])

export function recordDiag(kind: string, ev: Omit<DiagEvent, 'kind' | 'ts'> = {}): void {
  counters[kind] = (counters[kind] || 0) + 1
  events.push({ ...ev, kind, ts: Date.now() })
  if (events.length > MAX_EVENTS) events.shift()

  const now = Date.now()
  const always = ALWAYS_LOG_KINDS.has(kind)
  if (always || now - (lastLoggedAt[kind] || 0) >= THROTTLE_MS) {
    if (!always) lastLoggedAt[kind] = now
    console.warn(`[Diag] ${kind}`, ev)
  }
}

export function getDiagSnapshot(): { counters: Record<string, number>; events: DiagEvent[] } {
  return { counters: { ...counters }, events: events.slice() }
}

export function resetDiag(): void {
  for (const k of Object.keys(counters)) delete counters[k]
  events.length = 0
  for (const k of Object.keys(lastLoggedAt)) delete lastLoggedAt[k]
}

export function attachDiagToWindow(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __candleDiag: unknown }).__candleDiag = {
    inspect: getDiagSnapshot,
    reset: resetDiag,
  }
}

attachDiagToWindow()
