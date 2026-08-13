import type { UnifiedCandle, Exchange } from '../types'
import { isFiniteOHLCV } from './candle-utils'

/**
 * Chart-time conversion (scalpboard `we()` equivalent).
 *
 * The server streams candle timestamps as UTC epoch seconds. Scalpboard
 * shifts the data by the local timezone offset ONCE at the paint boundary so
 * the time axis reads in local time (the same as a TradingView chart).
 *
 * IMPORTANT: all guards and bookkeeping (tick window, period math) run on
 * RAW UTC seconds — only the values handed to lightweight-charts are
 * shifted. A constant shift never changes the relative spacing, so logical
 * ranges and window guards stay exact.
 */
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * 60

export function toChartTime(tSec: number): number {
  return tSec - TZ_OFFSET_SEC
}

export interface TickPayload {
  price: number
  /** Trade/exchange time in UTC seconds (raw, NOT shifted). */
  timeSec: number
}

/** One bar to paint via `series.update()` (exact scalpboard Cn/En semantics). */
export interface BarUpdate {
  bar: UnifiedCandle
  /** kline snapshots write volume; price ticks never touch it. */
  paintVolume: boolean
}

export interface ChartEventPatch {
  updates: BarUpdate[]
  /** Full history replace (setData) — the caller paints it, not this layer. */
  history?: UnifiedCandle[]
  /** Older page for lazy scroll (setData with the merged array). */
  prepend?: UnifiedCandle[]
  livePrice?: number
  cacheWrites?: UnifiedCandle[]
}

const EMPTY_PATCH = (): ChartEventPatch => ({ updates: [] })

export interface CandleEventsOpts {
  symbol: string
  exchange: Exchange
  tf: string
  tfSeconds: number
}

/**
 * Live-candle event layer — the "dumb renderer" (scalpboard's Cn/En).
 *
 * THE SERVER IS THE ONLY SOURCE OF TRUTH:
 *  - kline snapshot: the bar at that time is REPLACED wholesale (open, high,
 *    low, close, volume). No merging, no pinned open, no monotonic wicks,
 *    no isFinal branching — exactly like scalpboard's updateLastKline.
 *  - price tick: mutates ONLY the last bar's close/high/low within the
 *    current period window [lastBar.time, lastBar.time + tfSec). open and
 *    volume are NEVER touched by a tick (scalpboard's updateLastPrice).
 *    Identical consecutive prices are skipped (dedupe), because the trade
 *    lane here can carry many prints at one price per second.
 *  - a tick that falls outside the window is DROPPED (no synthetic candle,
 *    no mid-weighting, no fallback bucketing). If the market is quiet the
 *    chart simply does not move until the next kline — like scalpboard.
 *  - klines older than the tail are IGNORED (lightweight-charts cannot
 *    update a non-last bar, and scalpboard never repaints history live).
 *
 * The only bookkeeping kept here is: the tail bar (for windowing + tick
 * mutation) and a small reconcile buffer used while a history load is in
 * flight (events arriving during the fetch are replayed on top of the
 * freshly loaded history — the same pattern scalpboard's loader uses).
 */
export interface CandleEvents {
  applyKline(kline: UnifiedCandle): ChartEventPatch
  applyTick(tick: TickPayload): ChartEventPatch
  /** Reset the tail to match a freshly loaded full history. */
  applyHistory(candles: UnifiedCandle[]): void
  applyOlderPage?(candles: UnifiedCandle[]): void
  setBuffered(on: boolean): ChartEventPatch
  destroy(): void
}

const MAX_BUFFERED_EVENTS = 1000
const MAX_TAIL = 16

interface TailEntry {
  candle: UnifiedCandle
  /** Last tick price actually applied to this bar — dedupe anchor. */
  lastTickPrice: number
}

interface BufferedEvent {
  kind: 'kline' | 'tick'
  kline?: UnifiedCandle
  tick?: TickPayload
}

export function createCandleEvents(opts: CandleEventsOpts): CandleEvents {
  const { symbol, exchange, tf, tfSeconds } = opts

  let tail: TailEntry[] = []
  let buffered = false
  let destroyed = false
  let bufferedEvents: BufferedEvent[] = []

  function current(): TailEntry | null {
    return tail.length > 0 ? tail[tail.length - 1] : null
  }

  function pushTail(entry: TailEntry) {
    tail.push(entry)
    if (tail.length > MAX_TAIL) {
      tail = tail.slice(tail.length - MAX_TAIL)
    }
  }

  function klinePatch(kline: UnifiedCandle): ChartEventPatch {
    return {
      updates: [{ bar: kline, paintVolume: true }],
      livePrice: kline.close,
      cacheWrites: [kline],
    }
  }

  function applyKline(kline: UnifiedCandle): ChartEventPatch {
    if (destroyed) return EMPTY_PATCH()
    if (!isFiniteOHLCV(kline) || kline.time <= 0) return EMPTY_PATCH()

    if (buffered) {
      bufferedEvents.push({ kind: 'kline', kline })
      if (bufferedEvents.length > MAX_BUFFERED_EVENTS) bufferedEvents.shift()
      return EMPTY_PATCH()
    }

    const cur = current()
    if (cur && kline.time < cur.candle.time) {
      // Stale/late kline for an old period — lightweight-charts rejects an
      // update older than the series' last bar, and scalpboard drops it too.
      // The period keeps whatever snapshot was painted when it was current.
      return EMPTY_PATCH()
    }

    // Full replace: if the period already exists in the tail, the opening
    // price of the NEW snapshot wins (no pinned open, no merge). If it's a
    // new period, this appends the bar.
    const next: UnifiedCandle = { ...kline, symbol, exchange, timeframe: tf }
    const idx = tail.findIndex(t => t.candle.time === kline.time)
    if (idx >= 0) {
      tail[idx] = { candle: next, lastTickPrice: tail[idx].lastTickPrice }
    } else {
      pushTail({ candle: next, lastTickPrice: 0 })
    }
    return klinePatch(next)
  }

  function applyTick(tick: TickPayload): ChartEventPatch {
    if (destroyed) return EMPTY_PATCH()
    if (!isFinite(tick.price) || tick.price <= 0) return EMPTY_PATCH()

    if (buffered) {
      bufferedEvents.push({ kind: 'tick', tick })
      if (bufferedEvents.length > MAX_BUFFERED_EVENTS) bufferedEvents.shift()
      return EMPTY_PATCH()
    }

    const cur = current()
    if (!cur) return EMPTY_PATCH()

    // Scalpboard's updateLastPrice window: the tick must belong to the
    // period already opened by a kline — strictly after its start and
    // strictly before the next period. Anything else is dropped.
    if (!(tick.timeSec > cur.candle.time && tick.timeSec < cur.candle.time + tfSeconds)) {
      return EMPTY_PATCH()
    }

    // Dedupe: identical consecutive tick prices produce no visible change;
    // skipping them keeps the trade lane from spamming update() per print.
    if (tick.price === cur.lastTickPrice) return EMPTY_PATCH()

    const prev = cur.candle
    const mutated: UnifiedCandle = {
      ...prev,
      high: Math.max(prev.high, tick.price),
      low: Math.min(prev.low, tick.price),
      close: tick.price,
    }
    cur.lastTickPrice = tick.price
    cur.candle = mutated

    return {
      updates: [{ bar: mutated, paintVolume: false }],
      livePrice: tick.price,
    }
  }

  function applyHistory(candles: UnifiedCandle[]): void {
    if (destroyed) return
    const valid = candles.filter(c => isFiniteOHLCV(c) && c.time > 0)
    tail = []
    if (valid.length === 0) return
    const start = Math.max(0, valid.length - MAX_TAIL)
    for (let i = start; i < valid.length; i++) {
      tail.push({ candle: { ...valid[i] }, lastTickPrice: 0 })
    }
  }

  function applyOlderPage(candles: UnifiedCandle[]): void {
    if (destroyed) return
    // Older pages never belong to the tail window; the tail is the newest
    // bar and a prepend cannot change it. Nothing to do — kept only to
    // document that prepending history does not touch live state.
    void candles
  }

  function setBuffered(on: boolean): ChartEventPatch {
    if (destroyed) return EMPTY_PATCH()

    if (on) {
      if (!buffered) {
        buffered = true
        bufferedEvents = []
      }
      return EMPTY_PATCH()
    }

    buffered = false
    const patch: ChartEventPatch = { updates: [] }
    for (const ev of bufferedEvents) {
      const p = ev.kind === 'kline' && ev.kline
        ? applyKline(ev.kline)
        : ev.kind === 'tick' && ev.tick
          ? applyTick(ev.tick)
          : EMPTY_PATCH()
      patch.updates.push(...p.updates)
      if (p.livePrice != null) patch.livePrice = p.livePrice
      if (p.cacheWrites) {
        if (!patch.cacheWrites) patch.cacheWrites = []
        patch.cacheWrites.push(...p.cacheWrites)
      }
    }
    bufferedEvents = []
    return patch
  }

  function destroy() {
    destroyed = true
    tail = []
    bufferedEvents = []
  }

  return {
    applyKline,
    applyTick,
    applyHistory,
    applyOlderPage,
    setBuffered,
    destroy,
  }
}