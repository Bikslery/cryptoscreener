import type { UnifiedCandle, Exchange } from '../types'
import { isFiniteOHLCV } from './candle-utils'
import { recordDiag } from './candle-diag'

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
 *
 * The offset is captured ONCE per session and must stay CONSTANT for the
 * lifetime of the painted series: recomputing it per call made a tab open
 * across a DST transition paint new bars with a +1h shift against existing
 * ones — a one-hour whitespace band inserted mid-series. A frozen shift
 * keeps the series internally consistent; worst case the axis reads an hour
 * off until reload, which is what TradingView does too.
 */
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * 60

export function toChartTime(tSec: number): number {
  return tSec - TZ_OFFSET_SEC
}

export interface TickPayload {
  price: number
  /** Trade/exchange time in UTC seconds (raw, NOT shifted). */
  timeSec: number
  /** Quotes are display-only and must never create executed OHLC values. */
  source?: 'trade' | 'quote'
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
  /**
   * Klines that arrived for a period OLDER than the tail (out-of-order
   * correction candidates). This layer's own tail window is bounded
   * (MAX_TAIL) so it cannot tell whether the bar still exists further back
   * in the caller's full candle array — the caller checks `candlesDataRef`
   * and, if the bar is found there, repaints it in place (lightweight-charts
   * v5 `series.update(bar, true)` — historical update, no setData/viewport
   * reset needed). If the bar isn't found there either, there is nothing
   * left to correct and it's just dropped (already logged by this layer).
   * An array because a single buffered-replay flush can surface more than
   * one late correction at once.
   */
  outOfOrder?: { time: number; bar: UnifiedCandle }[]
}

const EMPTY_PATCH = (): ChartEventPatch => ({ updates: [] })

/** Read-only snapshot of one tail entry — for the invariant logger only. */
export interface TailSnapshot {
  time: number
  close: number
}

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
  /**
   * Advance the tail through client-side gap-filler bars WITHOUT producing
   * patches — the caller paints them itself. Keeps tick-window bookkeeping
   * (`cur.candle.time`) aligned with what the chart actually shows, so a
   * forward-filled jump does not leave the events layer stuck on a stale
   * period while the series has moved on.
   */
  forwardFill(fillers: UnifiedCandle[]): void
  /**
   * Nested-safe buffering. `on=true` increments a depth counter; `on=false`
   * decrements it. The buffer is only flushed (replayed) when depth returns
   * to 0 — while ANY caller still holds it open (reconnect history reload
   * racing a lazy-scroll prepend, for example), events keep queuing instead
   * of one caller's `setBuffered(false)` prematurely releasing the other's
   * hold. Returns EMPTY_PATCH while depth stays above 0.
   */
  setBuffered(on: boolean): ChartEventPatch
  /** Read-only tail snapshot for the invariant logger (last N bars). */
  peekTail(n?: number): TailSnapshot[]
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
  /** Monotonic arrival sequence — tiebreaker when two events share a time. */
  seq: number
}

function bufferedEventTime(ev: BufferedEvent): number {
  return ev.kind === 'kline' ? (ev.kline?.time ?? 0) : (ev.tick?.timeSec ?? 0)
}

export function createCandleEvents(opts: CandleEventsOpts): CandleEvents {
  const { symbol, exchange, tf, tfSeconds } = opts

  let tail: TailEntry[] = []
  // Depth counter (generation-style), not a boolean: see setBuffered doc.
  let bufferDepth = 0
  let destroyed = false
  let bufferedEvents: BufferedEvent[] = []
  let bufferSeq = 0

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

    if (bufferDepth > 0) {
      bufferedEvents.push({ kind: 'kline', kline, seq: bufferSeq++ })
      if (bufferedEvents.length > MAX_BUFFERED_EVENTS) bufferedEvents.shift()
      return EMPTY_PATCH()
    }

    const cur = current()
    if (cur && kline.time < cur.candle.time) {
      // Stale/late kline for an old period. lightweight-charts' `update()`
      // rejects a time older than the series' last bar, so this can never
      // repaint the live series directly — but the bar may still be sitting
      // further back in the caller's full candle array (outside this
      // layer's bounded MAX_TAIL window). Surface it as an out-of-order
      // correction candidate instead of a silent drop: the caller looks it
      // up in candlesDataRef and, if found, repaints it in place via
      // `series.update(bar, true)` (historicalUpdate) — no setData, no
      // viewport reset.
      const stamped: UnifiedCandle = { ...kline, symbol, exchange, timeframe: tf }
      recordDiag('kline_out_of_order', {
        symbol, exchange, tf,
        from: kline.time,
        to: cur.candle.time,
        detail: `late kline for closed period (tail=${cur.candle.time})`,
      })
      // Still worth persisting to the candle cache (which supports a sorted
      // upsert for exactly this backfill case — see candle-cache.ts
      // updateCandle) even though it can't be live-painted by `update()`.
      return { updates: [], outOfOrder: [{ time: kline.time, bar: stamped }], cacheWrites: [stamped] }
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
    if (tick.source === 'quote') return EMPTY_PATCH()

    if (bufferDepth > 0) {
      bufferedEvents.push({ kind: 'tick', tick, seq: bufferSeq++ })
      if (bufferedEvents.length > MAX_BUFFERED_EVENTS) bufferedEvents.shift()
      return EMPTY_PATCH()
    }

    const cur = current()
    if (!cur) return EMPTY_PATCH()

    // Scalpboard's updateLastPrice window: a tick mutates the bar already
    // opened for its period — strictly after its start and strictly before
    // the next period.
    if (tick.timeSec > cur.candle.time && tick.timeSec < cur.candle.time + tfSeconds) {
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

    // The NEXT period opened by a print before its first kline snapshot
    // arrived (quiet pair / kline-lane hiccup): synthesize the forming bar
    // from the trade itself instead of freezing on the old bar until the
    // kline lands. The very next authoritative kline REPLACES this bar
    // wholesale (applyKline full-replace), so OHLC stays exchange-true;
    // volume stays 0 because trades never paint volume.
    // A jump of more than one period is NOT synthesized here — that is the
    // clock-skew / stale-tail case handled by the caller's jump bridge.
    const alignedPeriod = Math.floor(tick.timeSec / tfSeconds) * tfSeconds
    if (alignedPeriod === cur.candle.time + tfSeconds) {
      const opened: UnifiedCandle = {
        ...cur.candle,
        time: alignedPeriod,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 0,
        isFinal: false,
      }
      pushTail({ candle: opened, lastTickPrice: tick.price })
      return {
        updates: [{ bar: opened, paintVolume: false }],
        livePrice: tick.price,
      }
    }

    // Anything else (older than the tail or multi-period ahead) is dropped.
    return EMPTY_PATCH()
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
      if (bufferDepth === 0) {
        bufferedEvents = []
      }
      bufferDepth++
      return EMPTY_PATCH()
    }

    // Guard against an unmatched setBuffered(false) (defensive — depth
    // should never go negative, but a stray extra call must not corrupt it).
    if (bufferDepth === 0) return EMPTY_PATCH()
    bufferDepth--
    if (bufferDepth > 0) {
      // Another caller is still holding the buffer open (e.g. a WS-reconnect
      // history reload racing a lazy-scroll prepend) — do NOT replay yet.
      return EMPTY_PATCH()
    }

    // Depth reached 0: replay strictly sorted by event time (arrival order
    // as a tiebreaker) so a reconnect-buffered kline and a lazy-scroll
    // buffered tick that raced in arrival order still apply in true
    // chronological order against the freshly-settled tail.
    const toReplay = bufferedEvents.slice().sort((a, b) => {
      const dt = bufferedEventTime(a) - bufferedEventTime(b)
      return dt !== 0 ? dt : a.seq - b.seq
    })
    bufferedEvents = []

    const patch: ChartEventPatch = { updates: [] }
    const tailTimeAtFlushStart = current()?.candle.time
    let droppedStale = 0
    for (const ev of toReplay) {
      const evTime = bufferedEventTime(ev)
      const p = ev.kind === 'kline' && ev.kline
        ? applyKline(ev.kline)
        : ev.kind === 'tick' && ev.tick
          ? applyTick(ev.tick)
          : EMPTY_PATCH()
      if (p.updates.length === 0 && !p.outOfOrder && tailTimeAtFlushStart != null && evTime < tailTimeAtFlushStart) {
        droppedStale++
      }
      patch.updates.push(...p.updates)
      if (p.livePrice != null) patch.livePrice = p.livePrice
      if (p.cacheWrites) {
        if (!patch.cacheWrites) patch.cacheWrites = []
        patch.cacheWrites.push(...p.cacheWrites)
      }
      if (p.outOfOrder) {
        if (!patch.outOfOrder) patch.outOfOrder = []
        patch.outOfOrder.push(...p.outOfOrder)
      }
    }
    if (droppedStale > 0) {
      recordDiag('buffer_replay_drop_stale', {
        symbol, exchange, tf,
        detail: `${droppedStale} buffered event(s) older than the settled tail dropped on replay`,
      })
    }
    return patch
  }

  function forwardFill(fillers: UnifiedCandle[]): void {
    if (destroyed) return
    for (const f of fillers) {
      if (!isFiniteOHLCV(f) || f.time <= 0) continue
      const cur = current()
      // Only ever move FORWARD through time — a filler older than the tail is
      // bookkeeping noise and must not rewind tick windows.
      if (!cur || f.time <= cur.candle.time) continue
      pushTail({ candle: f, lastTickPrice: 0 })
    }
  }

  function peekTail(n: number = MAX_TAIL): TailSnapshot[] {
    const start = Math.max(0, tail.length - n)
    return tail.slice(start).map(t => ({ time: t.candle.time, close: t.candle.close }))
  }

  function destroy() {
    destroyed = true
    tail = []
    bufferedEvents = []
    bufferDepth = 0
  }

  return {
    applyKline,
    applyTick,
    applyHistory,
    applyOlderPage,
    forwardFill,
    setBuffered,
    peekTail,
    destroy,
  }
}
