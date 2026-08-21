import { useEffect, useLayoutEffect, useRef, memo, useState, useMemo, useCallback } from 'react'
import { createChart, CandlestickSeries, BarSeries, LineSeries, HistogramSeries, PriceScaleMode } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time, SeriesType, DeepPartial, CandlestickSeriesOptions, BarSeriesOptions, LineSeriesOptions } from 'lightweight-charts'
import { useCoinListStore, setLivePrice, setLivePriceEx, useAuthStore } from '../../store'
import { useSmoothedPriceRef } from '../../hooks/useSmoothedPrice'
import { registerGlider, unregisterGlider, type Glider } from '../../services/glide'
import { stepFormingAnimation, formingGlideK, FORMING_LIVE_INTERVAL_MS, FORMING_QUIET_K60, FORMING_LIVE_K60, type FormingTarget } from '../../services/candle-anim'
import type { ChartExchange } from '../../store'
import { useShallow } from 'zustand/shallow'
import { wsOnChannel, wsOnType, wsSubscribe, wsUnsubscribe, getWsOpenCount, getWsLastMessageAt } from '../../services/ws'
import type { Timeframe, UnifiedCandle, Exchange, DrawingTool, UnifiedTicker } from '../../types'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { resolveIndicators, formatIndicator } from '../../services/indicators'
import { ArrowLeft, Settings2 } from 'lucide-react'
import * as candleCache from '../../services/candle-cache'
import { getOrFetchHistory, getOrFetchOlder, getOrFetchBulk, GRID_CANDLE_LIMIT, EXPANDED_CANDLE_LIMIT } from '../../services/candle-prefetch'
import { expandCompactCandles, type CompactCandle } from '../../services/candle-compact'
import { createCandleEvents, toChartTime, type CandleEvents, type ChartEventPatch, type TickPayload } from '../../services/candle-events'
import { captureViewport, restoreViewport, saveViewport, getViewport } from '../../services/chart-viewport'
import { canPaintPartialHistory, replaceDataPreservingPriceScale, resolveHistoryViewportAction } from '../../services/chart-history-paint'
import { isFiniteOHLCV, validateCandle, MAX_FORWARD_FILL_PERIODS, forwardFillGap, isFlatFiller } from '../../services/candle-utils'
import { resolveHistoryLoadPlan } from '../../services/history-load-plan'
import { recordDiag } from '../../services/candle-diag'
import { useDrawings } from './useDrawings'
import DrawingToolsPanel from './DrawingToolsPanel'
import { useChartOverlays } from './overlays/useChartOverlays'
import { useDensityOverlay } from './overlays/useDensityOverlay'
import { useChartSettings, resetChartSettings, type WatermarkPlace } from '../../services/chart-settings'
import {
  buildChartOptions, candleSeriesOptions, volumeSeriesOptions,
  applyWatermark, volumePaneTop, timeVisibleFor, secondsVisibleFor,
} from '../../services/chart-config'


const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}
function getTfSeconds(tf: Timeframe): number { return TF_SECONDS[tf] || 60 }

/**
 * "Dumb renderer" (scalpboard.io parity).
 *
 * The server is the ONLY source of truth for candles. The client paints
 * kline snapshots wholesale and mutates ONLY the last bar's close/high/low
 * from price ticks (open and volume are never touched by a tick). There is
 * no client-side aggregation, no glide, no sanity clamping, no synthetic
 * filler candles and no self-heal: what the server says is what is drawn.
 */
function upsertBar(candlesDataRef: React.RefObject<UnifiedCandle[]>, bar: UnifiedCandle): void {
  const arr = candlesDataRef.current
  if (!arr) return
  const last = arr[arr.length - 1]
  if (!last) { arr.push(bar); return }
  if (bar.time === last.time) {
    arr[arr.length - 1] = bar
  } else if (bar.time > last.time) {
    arr.push(bar)
  }
  // Older than the tail is dropped by the events layer — nothing to do.
}

/**
 * Smooth forming-candle renderer (scalpboard-style glide).
 *
 * The backing array stays authoritative and exact; this animator only
 * interpolates what gets PAINTED on the last (forming) bar. Each live update
 * (price tick / kline snapshot for the current period) sets a new target; the
 * SHARED rAF coordinator (glide.ts) advances it with frame-rate-independent
 * exponential smoothing and stops when converged (~100ms). Final candles,
 * history loads and repaints always paint exact values — the animation never
 * touches data.
 */
// Exported for unit tests only (see __tests__/forming-animator.test.ts) —
// not part of the component's public surface. This breaks the
// components-only-exports assumption react-refresh relies on for this file;
// acceptable since ChartGrid.tsx already isn't a clean fast-refresh boundary
// (it also exports helper hooks alongside components).
// eslint-disable-next-line react-refresh/only-export-components
export class FormingAnimator implements Glider {
  private displayed: FormingTarget | null = null
  private target: FormingTarget | null = null
  private running = false
  private readonly series: ISeriesApi<SeriesType>
  private readonly getRef: () => ISeriesApi<SeriesType> | null
  /** True while the pair is retargeting faster than FORMING_LIVE_INTERVAL_MS —
   *  live pairs glide with the faster FORMING_LIVE_K60, quiet ones smoothly
   *  with FORMING_QUIET_K60. */
  private live = false
  /** When the last target was set — a retarget sooner than the live
   *  interval means a live pair. */
  private lastTargetAt = 0

  constructor(series: ISeriesApi<SeriesType>, getRef: () => ISeriesApi<SeriesType> | null) {
    this.series = series
    this.getRef = getRef
  }

  get isAnimating(): boolean {
    return this.running
  }

  /**
   * Route a live forming-candle update through the animator. Returns true
   * when handled.
   *
   * NOTE: under the current applyChartPatch dispatch, this only ever
   * receives updates for the SAME period this animator is already tracking
   * (isFormingBar gates on the caller's side); a genuinely new period is
   * routed through the exact-paint branch + `finalizeAndReset()` instead.
   * The `displayed.time !== t.time` branch below is kept as a defensive
   * fallback for that invariant — if it's ever hit, it still does the right
   * thing (finalize the old bar's exact target before snapping to the new
   * one) rather than silently glide-jumping across a period boundary.
   */
  paint(c: UnifiedCandle): boolean {
    const t: FormingTarget = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }
    if (!this.displayed || this.displayed.time !== t.time) {
      // Bar handoff (Stage 2 item 3): finalize whatever the PREVIOUS bar's
      // glide was converging toward — its exact last-known target — before
      // abandoning it. Without this, a glide frozen mid-flight (running,
      // displayed lagging target) leaves the closed bar's body stuck at a
      // non-final interpolated frame forever, since nothing ever repaints a
      // bar again once it's no longer the series' last one.
      this.finalizeCurrent()
      // Fully clear + unregister rather than leaving `running`/registration
      // dangling: `displayed` is about to be set equal to `target` for the
      // NEW bar below (a fresh snap has no glide yet), so there is nothing
      // for the shared rAF coordinator to advance until an actual second
      // update arrives for this new bar. Without this explicit clear, the
      // OLD registration would linger in the shared gliders Set for one
      // extra (wasted, self-converging) frame before naturally dropping out.
      this.clearState()
      // New bar: snap exactly — the glide must never stretch across period
      // boundaries. (Starting the new bar's displayed body from anything
      // other than the server-provided `c.open` — e.g. forcing
      // open = previous close — would silently override authoritative
      // data on a real price gap, so `open` here is always exactly what the
      // server sent.)
      this.target = t
      this.displayed = { ...t }
      this.lastTargetAt = performance.now()
      this.paintSeries(this.displayed)
      return true
    }
    this.target = t
    const now = performance.now()
    // Live-pair detection: retargets closer than FORMING_LIVE_INTERVAL_MS
    // switch to the fast glide (FORMING_LIVE_K60). Exponential smoothing has
    // no restart problem — every step continues from the current displayed
    // value toward the newest target — so a hot feed converges instead of
    // chasing forever, and the body never teleports between prints.
    this.live = now - this.lastTargetAt <= FORMING_LIVE_INTERVAL_MS
    this.lastTargetAt = now
    this.ensureLoop()
    return true
  }

  /**
   * Called when the previously-forming bar is being abandoned because the
   * caller is about to exact-paint a DIFFERENT bar directly (new period, an
   * out-of-order correction, or a candlesType flip) — snaps the OLD bar to
   * its last known exact target first (see `paint()` doc), then clears.
   */
  finalizeAndReset(): void {
    this.finalizeCurrent()
    this.clearState()
  }

  /**
   * Exact-data paths (setData) must stop any pending glide WITHOUT an extra
   * repaint: setData() is about to overwrite the entire series a moment
   * later (with the exact authoritative array), so finalizing here would be
   * wasted work at best and, since the series' internal bar set is about to
   * change wholesale, a needless extra `update()` call at worst.
   */
  reset() {
    this.clearState()
  }

  /** Shared-coordinator entry: advance one frame, false = converged/stop. */
  tick(dt: number): boolean {
    if (this.getRef() !== this.series || !this.target || !this.displayed) return false
    const k = formingGlideK(dt, this.live ? FORMING_LIVE_K60 : FORMING_QUIET_K60)
    const { next, converged } = stepFormingAnimation(this.displayed, this.target, k)
    if (converged) {
      this.displayed = { ...this.target }
      this.paintSeries(this.displayed)
      this.running = false
      return false
    }
    this.displayed = next
    this.paintSeries(next)
    return true
  }

  private ensureLoop() {
    if (this.running) return
    this.running = true
    registerGlider(this)
  }

  /** Snap the CURRENT bar to its exact last-known target if a glide was in
   * flight. No-op if nothing was running. Never clears state itself (callers
   * decide that) and never recurses into finalize/reset on failure — see
   * `paintSeries`. */
  private finalizeCurrent(): void {
    if (this.running && this.target) {
      this.paintSeries(this.target)
    }
  }

  private clearState(): void {
    if (this.running) {
      unregisterGlider(this)
      this.running = false
    }
    this.displayed = null
    this.target = null
  }

  private paintSeries(t: FormingTarget) {
    try {
      this.series.update({
        time: toChartTime(t.time) as Time,
        open: t.open,
        high: t.high,
        low: t.low,
        close: t.close,
      })
    } catch {
      // Series is gone (chart removed / recreated). This is a leaf
      // operation — clear state directly instead of recursing into
      // finalizeAndReset()/reset() (which would call back into
      // paintSeries() and could loop if the series keeps throwing).
      this.clearState()
    }
  }
}

// One animator per candle series (chart instance). WeakMap → GC'd with the
// series; the loop self-stops when the ref no longer points at this series
// (unmount, or a series recreate like the candlesType flip).
const formingAnimators = new WeakMap<ISeriesApi<SeriesType>, FormingAnimator>()

function getFormingAnimator(
  series: ISeriesApi<SeriesType>,
  getRef: () => ISeriesApi<SeriesType> | null,
): FormingAnimator {
  let a = formingAnimators.get(series)
  if (!a) {
    a = new FormingAnimator(series, getRef)
    formingAnimators.set(series, a)
  }
  return a
}

/** Exact-data paths (setData) must stop any pending forming-candle glide. */
function stopFormingGlide(candleRef: React.RefObject<ISeriesApi<SeriesType> | null>): void {
  const s = candleRef.current
  if (s) getFormingAnimator(s, () => candleRef.current).reset()
}

/** True when the update targets the current forming (last) bar. */
function isFormingBar(bar: UnifiedCandle, candlesDataRef: React.RefObject<UnifiedCandle[]>): boolean {
  const arr = candlesDataRef.current
  const last = arr && arr.length > 0 ? arr[arr.length - 1] : null
  return !!last && bar.time === last.time
}

/**
 * Period-jump forward-fill (TradingView-style continuity) — see
 * candle-utils.forwardFillGap. A quiet pair can go many periods without a
 * single kline; the sharp move that ends the silence arrives as a bar
 * SEVERAL periods ahead of the tail. Painting it directly makes
 * lightweight-charts insert internal whitespace for every skipped bucket —
 * the "empty stretch + lone detached candle" artifact. Bridge bars are flat
 * candles anchored to the previous close; `backfillJumpWindow` replaces them
 * with real rows seconds later (server cache-repair keeps that cache warm).
 */

// One background backfill per channel per window — several jumps in a row
// must not stampede REST.
const JUMP_BACKFILL_THROTTLE_MS = 10_000
const jumpBackfillAt = new Map<string, number>()

/**
 * Replace freshly-forward-filled flat bars with REAL rows from the server
 * cache. Repaints in place via `series.update(bar, true)` (historicalUpdate)
 * — no setData, no viewport reset. Bounded to the filler region; anything the
 * cache cannot cover yet stays flat until the repair watchdog heals it and a
 * later history load paints it.
 */
function backfillJumpWindow(
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  symbol: string,
  tf: Timeframe,
  exchange?: Exchange,
): void {
  const key = `${exchange ?? 'auto'}:${symbol}:${tf}`
  const now = Date.now()
  if (now - (jumpBackfillAt.get(key) ?? 0) < JUMP_BACKFILL_THROTTLE_MS) return
  jumpBackfillAt.set(key, now)
  if (jumpBackfillAt.size > 200) {
    for (const [k, ts] of jumpBackfillAt) {
      if (now - ts > JUMP_BACKFILL_THROTTLE_MS) jumpBackfillAt.delete(k)
    }
  }

  getOrFetchHistory(symbol, tf, GRID_CANDLE_LIMIT, exchange)
    .then(data => {
      const arr = candlesDataRef.current
      const series = candleRef.current
      if (!arr || arr.length === 0 || !series || data.length === 0) return
      const candlesType = useChartSettings.getState().candlesType
      if (candlesType === 'line') return
      const realByTime = new Map<number, UnifiedCandle>()
      for (const c of data) realByTime.set(c.time, c)

      // Scan the tail region where fillers live (they were just appended).
      let checked = 0
      for (let i = arr.length - 1; i >= 0 && checked <= MAX_FORWARD_FILL_PERIODS + 2; i--, checked++) {
        const cur = arr[i]
        if (!isFlatFiller(cur)) continue
        const real = realByTime.get(cur.time)
        if (!real || !validateCandle(real)) continue
        if (real.close === cur.close && real.open === cur.open && real.high === cur.high && real.low === cur.low && real.volume === cur.volume) continue
        arr[i] = { ...real }
        try {
          series.update({
            time: toChartTime(real.time) as Time,
            open: real.open, high: real.high, low: real.low, close: real.close,
          }, true)
          volumeRef.current?.update({ time: toChartTime(real.time) as Time, value: real.volume }, true)
        } catch { /* series recreated mid-backfill — next history load covers */ }
      }
    })
    .catch(() => { /* transient — the next jump or history load retries */ })
}

/**
 * Source tag for diagnostics only — identifies which lane produced the patch
 * being applied (kline stream, trade tick, bookTicker mid, or a buffered-flush
 * replay from a history/lazy-scroll cycle).
 * Never affects behavior, only what gets logged when something looks wrong.
 */
type PatchSource = 'kline' | 'tick-trade' | 'tick-price' | 'history-flush' | 'lazy-scroll-flush'

function applyChartPatch(
  patch: ChartEventPatch,
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  source: PatchSource,
  eventsRef?: React.RefObject<CandleEvents | null>,
) {
  const candlesType = useChartSettings.getState().candlesType
  const series = candleRef.current
  // Only OHLC series can glide — a line series paints { time, value } only.
  const animator = series && candlesType !== 'line' ? getFormingAnimator(series, () => candleRef.current) : null
  for (const u of patch.updates) {
    const bar = u.bar
    const t = toChartTime(bar.time) as Time

    // ── Period-jump forward-fill ──────────────────────────────────────────
    // The incoming bar lands SEVERAL periods after the tail (quiet pair →
    // sharp move). Paint flat bridge bars first so lightweight-charts never
    // inserts whitespace between the tail and the new bar.
    const jumpArr = candlesDataRef.current
    const lastArrBar = jumpArr && jumpArr.length > 0 ? jumpArr[jumpArr.length - 1] : null
    if (lastArrBar && lastArrBar.time > 0 && bar.time > lastArrBar.time) {
      const tfSec = getTfSeconds(tf)
      const gapPeriods = Math.round((bar.time - lastArrBar.time) / tfSec)
      if (gapPeriods > 1 && gapPeriods <= MAX_FORWARD_FILL_PERIODS + 1) {
        const fillers = forwardFillGap(lastArrBar, bar.time, tfSec)
        try {
          // Same handoff rule as a normal new-period paint: snap the old
          // bar's pending glide to its exact target before moving the
          // series' time forward.
          if (animator) animator.finalizeAndReset()
          const lineMode = candlesType === 'line'
          for (const f of fillers) {
            const ft = toChartTime(f.time) as Time
            if (lineMode) {
              candleRef.current?.update({ time: ft, value: f.close })
            } else {
              candleRef.current?.update({ time: ft, open: f.open, high: f.high, low: f.low, close: f.close })
            }
            volumeRef.current?.update({ time: ft, value: 0 })
            upsertBar(candlesDataRef, f)
          }
          eventsRef?.current?.forwardFill(fillers)
        } catch (err) {
          recordDiag('forward_fill_paint_failed', {
            symbol, exchange, tf,
            from: lastArrBar.time, to: bar.time,
            detail: `source=${source} error=${err instanceof Error ? err.message : String(err)}`,
          })
        }
        recordDiag('period_jump_filled', {
          symbol, exchange, tf,
          from: lastArrBar.time, to: bar.time,
          detail: `gap=${gapPeriods - 1}p filled=${fillers.length} source=${source}`,
        })
        backfillJumpWindow(candleRef, volumeRef, candlesDataRef, symbol, tf, exchange)
      } else if (gapPeriods > MAX_FORWARD_FILL_PERIODS + 1) {
        // Absurd jump (clock skew / bad data): do NOT synthesize hundreds of
        // bars — log it; the next history load repaints truthfully.
        recordDiag('period_jump_skipped', {
          symbol, exchange, tf,
          from: lastArrBar.time, to: bar.time,
          detail: `gap=${gapPeriods - 1}p exceeds cap ${MAX_FORWARD_FILL_PERIODS}, source=${source}`,
        })
      }
    }

    try {
      if (candlesType === 'line') {
        candleRef.current?.update({ time: t, value: bar.close })
      } else if (animator && isFormingBar(bar, candlesDataRef)) {
        // Live forming-candle update (price tick / current-period kline):
        // the body GLIDES toward the new price instead of teleporting. The
        // array keeps the exact authoritative bar (upsertBar below).
        animator.paint(bar)
      } else {
        // New period / full snapshot: this is the bar-handoff point (Stage 2
        // item 3). The animator may still be mid-glide for the PREVIOUS
        // forming bar (its `displayed` lagging `target`) — finalizeAndReset
        // snaps that old bar to its exact final target first (so it never
        // freezes on a stale interpolated frame once it stops being the
        // last bar) and only then clears the glide state, before this new
        // bar's exact values are painted below.
        if (animator) animator.finalizeAndReset()
        candleRef.current?.update({ time: t, open: bar.open, high: bar.high, low: bar.low, close: bar.close })
      }
      if (u.paintVolume) {
        volumeRef.current?.update({ time: t, value: bar.volume })
      }
    } catch (err) {
      // series.update() throws when the bar's time is older than the
      // series' current last bar (lightweight-charts monotonic-time
      // invariant) or when the series was recreated mid-paint
      // (pricePrecision flip). Never swallow silently — log exactly which
      // bar/source caused it so a reconnect/lazy-scroll/tf-switch race can
      // be traced back to its origin instead of just "candles look wrong".
      const arr = candlesDataRef.current
      const lastArrBar = arr && arr.length > 0 ? arr[arr.length - 1] : null
      recordDiag('series_update_rejected', {
        symbol, exchange, tf,
        from: bar.time,
        to: lastArrBar?.time,
        detail: `source=${source} error=${err instanceof Error ? err.message : String(err)}`,
      })
    }
    upsertBar(candlesDataRef, bar)
  }
  if (patch.outOfOrder && patch.outOfOrder.length > 0) {
    applyOutOfOrderCorrections(patch.outOfOrder, candleRef, candlesDataRef, symbol, exchange, tf, source)
  }
  if (patch.livePrice != null) {
    setLivePrice(symbol, patch.livePrice)
    if (exchange) setLivePriceEx(symbol, exchange, patch.livePrice)
  }
  if (patch.cacheWrites && exchange) {
    for (const c of patch.cacheWrites) {
      candleCache.updateCandle(exchange, symbol, tf, c)
    }
  }
}

/**
 * Out-of-order kline correction (Stage 2, item "Out-of-order коррекции"):
 * a late kline snapshot arrived for a period the events layer has already
 * moved past (older than its own bounded tail window). Instead of a silent
 * drop, check whether the bar still exists in the FULL candlesDataRef array
 * (which is not bounded to MAX_TAIL) — if so, correct it in place via
 * lightweight-charts v5's `series.update(bar, true)` (historicalUpdate),
 * which repaints a non-last bar without a setData()/viewport reset. This is
 * a rare path (only real out-of-order server data triggers it), so a linear
 * findIndex from the tail backward is fine.
 */
function applyOutOfOrderCorrections(
  corrections: { time: number; bar: UnifiedCandle }[],
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  source: PatchSource,
) {
  const arr = candlesDataRef.current
  if (!arr || arr.length === 0) return
  const candlesType = useChartSettings.getState().candlesType
  if (candlesType === 'line') return // line series has no meaningful OHLC historical-update here
  const series = candleRef.current
  if (!series) return

  for (const { time, bar } of corrections) {
    const idx = arr.findIndex(c => c.time === time)
    if (idx < 0) {
      recordDiag('out_of_order_unresolved', {
        symbol, exchange, tf, from: time,
        detail: `source=${source} bar not found in candlesDataRef either — dropped`,
      })
      continue
    }
    arr[idx] = bar
    try {
      series.update(
        { time: toChartTime(bar.time) as Time, open: bar.open, high: bar.high, low: bar.low, close: bar.close },
        true, // historicalUpdate: allowed to touch a non-last bar
      )
      recordDiag('out_of_order_corrected', {
        symbol, exchange, tf, from: time,
        detail: `source=${source} repainted in place via historicalUpdate`,
      })
    } catch (err) {
      recordDiag('out_of_order_repaint_failed', {
        symbol, exchange, tf, from: time,
        detail: `source=${source} error=${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
}

/**
 * Temporary invariant logger (Stage 1): after every applyChartPatch/flush,
 * verify the tail of candlesDataRef agrees with the events layer's own tail
 * bookkeeping. Any mismatch means the array and the event layer have
 * diverged — which is exactly the class of bug this instrumentation exists
 * to catch (lazy-scroll race, reconnect race, tf/symbol switch mid-close,
 * animator handoff). Logs via candle-diag so it shows up in
 * `window.__candleDiag.inspect()` without touching rendering.
 */
function checkTailInvariant(
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  eventsRef: React.RefObject<CandleEvents | null> | undefined,
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  source: PatchSource,
  n = 3,
) {
  // Dev-only instrumentation: this ran on EVERY kline/trade patch across all
  // charts (peekTail + slice + map allocations per event). On a hot feed that
  // is hundreds of wasted allocations per second in production.
  if (!import.meta.env.DEV) return
  const ev = eventsRef?.current
  if (!ev) return
  const arr = candlesDataRef.current
  if (!arr || arr.length === 0) return
  const eventsTail = ev.peekTail(n)
  if (eventsTail.length === 0) return
  const arrTail = arr.slice(Math.max(0, arr.length - n)).map(c => ({ time: c.time, close: c.close }))

  // Compare from the right (most recent) — the events layer's tail is
  // capped at MAX_TAIL so it may hold fewer entries than requested.
  for (let i = 1; i <= eventsTail.length; i++) {
    const ePos = eventsTail.length - i
    const aPos = arrTail.length - i
    if (ePos < 0 || aPos < 0) break
    const e = eventsTail[ePos]
    const a = arrTail[aPos]
    if (e.time !== a.time) {
      recordDiag('tail_invariant_time_mismatch', {
        symbol, exchange, tf,
        from: e.time, to: a.time,
        detail: `source=${source} events-tail vs candlesDataRef diverged at offset ${i}`,
      })
      return
    }
    if (Math.abs(e.close - a.close) > 1e-9) {
      recordDiag('tail_invariant_price_mismatch', {
        symbol, exchange, tf,
        from: e.time,
        detail: `source=${source} events.close=${e.close} arr.close=${a.close} at offset ${i}`,
      })
      return
    }
  }
}

function ChartMessageOverlay({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'error' }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none bg-[#0a0a0a]/70">
      <div className={`rounded-[6px] border px-4 py-3 text-[12px] font-medium shadow-[0_12px_30px_rgba(0,0,0,0.35)] ${
        tone === 'error'
          ? 'border-[#e74c3c]/40 bg-[#1a1010]/95 text-[#f0b0aa]'
          : 'border-[#2a2a2a] bg-[#101010]/95 text-[#aaa]'
      }`}>
        {label}
      </div>
    </div>
  )
}

function ChartCornerSpinner() {
  return (
    <div className="absolute top-[8px] right-[8px] z-30 pointer-events-none">
      <div className="w-[14px] h-[14px] border-2 border-[#555] border-t-[#ccc] rounded-full animate-spin" />
    </div>
  )
}

function StaleDataOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <div className="stale-data-overlay absolute inset-0 z-40 flex items-center justify-center pointer-events-none bg-[#0a0a0a]/60 backdrop-blur-[3px]">
      <div className="rounded-[6px] border border-[#e74c3c]/40 bg-[#1a1010]/95 px-4 py-3 text-[12px] font-medium shadow-[0_12px_30px_rgba(0,0,0,0.35)] flex items-center gap-3">
        <div className="w-[14px] h-[14px] border-2 border-[#e74c3c]/40 border-t-[#e74c3c] rounded-full animate-spin" />
        <span className="text-[#f0b0aa]">Reconnecting to server...</span>
      </div>
    </div>
  )
}

/**
 * Merge-only bulk write for the reconnect `initial-candles` push. `storeBulk`
 * REPLACES each entry wholesale, so a 300-bar initial push used to truncate a
 * 3000-bar expanded-chart history down to 300 on every WS reconnect (shorter
 * scroll-back + an immediate refetch). `setCandles` merges and dedupes with
 * incoming-on-collision semantics instead.
 */
function storeBulkMerged(data: Record<string, UnifiedCandle[]>): void {
  for (const [key, candles] of Object.entries(data)) {
    if (!Array.isArray(candles) || candles.length === 0) continue
    const parts = key.split(':')
    if (parts.length !== 3) continue
    candleCache.setCandles(parts[0] as Exchange, parts[1], parts[2], candles)
  }
}

let initialPushReceived = false

function useInitialCandlesPush() {
  useEffect(() => {
    const unsubReconnect = wsOnType('open', () => {
      initialPushReceived = false
    })
    const unsubPush = wsOnType('initial-candles', (msg) => {
      if (initialPushReceived) return
      initialPushReceived = true
      const data = msg.data as Record<string, UnifiedCandle[] | CompactCandle[]> | undefined
      if (!data) return
      if ((msg as { format?: string }).format === 'compact') {
        // Keys are `${exchange}:${symbol}:${tf}`, values are [t,o,h,l,c,v] tuples
        const expanded: Record<string, UnifiedCandle[]> = {}
        for (const [key, tuples] of Object.entries(data)) {
          const parts = key.split(':')
          if (parts.length !== 3) continue
          const [ex, symbol, tf] = parts
          expanded[key] = expandCompactCandles(tuples as CompactCandle[], symbol, ex as Exchange, tf)
        }
        storeBulkMerged(expanded)
        return
      }
      storeBulkMerged(data as Record<string, UnifiedCandle[]>)
    })
    return () => { unsubReconnect(); unsubPush() }
  }, [])
}

/**
 * Per-chart recent-candles push (scalpboard's subscribe-klines parity): the
 * server answers a candle subscription with the last N candles immediately
 * (see hub.ts). Storing them into the shared candle cache lets useFullHistory's
 * SWR partial-paint path draw the chart from the socket — no REST round-trip.
 * `bumpRecentVersion` re-runs the history loader so it re-checks the cache the
 * moment the recent candles land.
 */
function useCandlesRecent(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  bumpRecentVersion: () => void,
) {
  useEffect(() => {
    if (!exchange) return
    const channel = `candle:${exchange}:${symbol}:${tf}`
    const unsub = wsOnChannel(channel, (msg) => {
      if ((msg as { type?: string }).type !== 'candles-recent') return
      const data = (msg as { data?: Record<string, CompactCandle[]> }).data
      if (!data || Object.keys(data).length === 0) return
      for (const [key, tuples] of Object.entries(data)) {
        const parts = key.split(':')
        if (parts.length !== 3) continue
        const [ex, sym, t] = parts
        const expanded = expandCompactCandles(tuples as CompactCandle[], sym, ex as Exchange, t)
        // setCandles MERGES with what's already cached (initial-candles, REST) —
        // never storeBulk, which REPLACES the entry and would truncate the
        // 300-candle initial-candles history down to this 64-candle recent tail.
        candleCache.setCandles(ex as Exchange, sym, t, expanded)
      }
      bumpRecentVersion()
    })
    return unsub
  }, [symbol, exchange, tf, bumpRecentVersion])
}

type FullHistoryStatus = 'loading' | 'ready' | 'empty' | 'error' | 'retrying'

/** Hard wall-clock deadline for the initial history load: after this the
 *  chart paints whatever exists (partial cache / live WS candles) instead of
 *  sitting on a blank spinner forever. Transient server failures (exchange
 *  throttle, route timeout) trigger ONE background retry — no page reload. */
const HISTORY_LOAD_DEADLINE_MS = 10_000

function useFullHistory(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  options?: { limit?: number; initialLimit?: number; visibleBars?: number; fitOnOpen?: boolean; forceServerToken?: number; wsEpoch?: number; recentVersion?: number },
  lastUpdateRef?: React.RefObject<number>,
  eventsRef?: React.RefObject<CandleEvents | null>,
  chartVersion?: number,
): { isInitialLoading: boolean; status: FullHistoryStatus; dataVersion: number } {
  const limit = options?.limit ?? 1000
  const initialLimit = options?.initialLimit ?? limit
  const fitOnOpen = options?.fitOnOpen ?? false
  const visibleBars = options?.visibleBars ?? 150
  const recentVersion = options?.recentVersion ?? 0
  // Force-server token semantics: the WS-open counter. A run triggered by a
  // token CHANGE (a fresh reconnect) bypasses the client cache ONCE so periods
  // lost during the dead window are healed from the server. Every later run
  // (symbol/TF switch, candles-recent bump, top-up) uses the cache again — the
  // old boolean stayed true forever after the first reconnect and made ALL
  // history loads ignore the cache until a page reload.
  const forceServerToken = options?.wsEpoch ?? 0
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [status, setStatus] = useState<FullHistoryStatus>('loading')
  const [dataVersion, setDataVersion] = useState(0)

  // Key of the last painted series — used to save the viewport we are about
  // to leave and to know whether a reload is a same-key refresh.
  const lastPaintedKeyRef = useRef<string | null>(null)
  const prevForceTokenRef = useRef<number | null>(null)
  useEffect(() => {
    if (!exchange) return
    const cancelled = { value: false }
    // Forced server round-trip only on a FRESH reconnect epoch (see the token
    // doc above). First run (prev === null) is never forced — the cache/SWR
    // path owns the first paint.
    const forceServer = forceServerToken > 0
      && prevForceTokenRef.current !== null
      && prevForceTokenRef.current !== forceServerToken
    prevForceTokenRef.current = forceServerToken
    const sameKeyReload = forceServer && lastPaintedKeyRef.current === `${exchange}:${symbol}:${tf}`
    // Already painted this key? A recentVersion re-run (candles-recent landed
    // after the full history) must NOT re-show the loading spinner over the
    // visible chart — only a first paint or a symbol/TF switch should.
    const alreadyPaintedThisKey = lastPaintedKeyRef.current === `${exchange}:${symbol}:${tf}`
    if (!sameKeyReload && !alreadyPaintedThisKey) setIsInitialLoading(true)
    const renderCandles = (candles: UnifiedCandle[]) => {
      if (destroyedRef.current || !candleRef.current || !volumeRef.current) {
        // Nothing was painted — release reconciliation so realtime events
        // that arrived during the fetch are not stuck in the buffer.
        eventsRef?.current?.setBuffered(false)
        return
      }
      const key = `${exchange}:${symbol}:${tf}`
      const ts = chartRef.current?.timeScale()

      // Save the viewport we're LEAVING (symbol/TF switch) so returning to
      // that pair restores exactly where the user left off.
      const prevKey = lastPaintedKeyRef.current
      if (ts && prevKey && prevKey !== key) {
        saveViewport(prevKey, captureViewport(chartRef.current))
      }

      const valid = candles.filter(validateCandle)
      candlesDataRef.current = valid
      const lineMode = useChartSettings.getState().candlesType === 'line'
      const candleData = lineMode
        ? valid.map(c => ({ time: toChartTime(c.time) as Time, value: c.close }))
        : valid.map(c => ({
            time: toChartTime(c.time) as Time, open: c.open, high: c.high, low: c.low, close: c.close,
          }))
      const volumeData = valid.map(c => ({
        time: toChartTime(c.time) as Time, value: c.volume,
      }))
      try {
        // Capture BEFORE setData — setData resets the whole time scale.
        const leavingKey = lastPaintedKeyRef.current
        if (leavingKey && leavingKey === key) {
          saveViewport(leavingKey, captureViewport(chartRef.current))
        }
        // Exact data replaces everything — a pending forming-candle glide
        // must not paint stale interpolated values onto the new series.
        stopFormingGlide(candleRef)
        replaceDataPreservingPriceScale(chartRef.current, () => {
          candleRef.current?.setData(candleData)
          volumeRef.current?.setData(volumeData)
        })
      } catch { /* benign: setData may throw on a fresh/empty series */ }
      if (ts && candleData.length > 0) {
        const saved = getViewport(key)
        const viewportAction = resolveHistoryViewportAction({
          hasViewport: saved !== null,
          fitOnOpen,
        })
        if (viewportAction === 'restore' && saved) {
          // setData resets the time scale. Background history therefore
          // restores the exact pre-update viewport instead of calling
          // fitContent and visibly zooming the chart after it is on screen.
          restoreViewport(chartRef.current, saved)
        } else if (viewportAction === 'fit') {
          // First expanded-chart paint only. Older history arriving later is
          // restored around this viewport and remains invisible to the user.
          ts.fitContent()
        } else {
          // Mini charts: how many bars fit on screen.
          const vbars = Math.min(Math.max(visibleBars, 20), 2000)
          ts.setVisibleLogicalRange({ from: candleData.length - vbars, to: candleData.length + 5 })
        }
      }
      lastPaintedKeyRef.current = key
      // Bump dataVersion so the drawing primitive re-syncs.
      setDataVersion(v => v + 1)
      if (eventsRef) {
        // History lands first, then buffered live events (klines/ticks that
        // arrived during the fetch) are replayed on top — never lost, never
        // double-painted.
        eventsRef.current?.applyHistory(valid)
        const flush = eventsRef.current?.setBuffered(false)
        if (flush && (flush.updates.length > 0 || (flush.outOfOrder && flush.outOfOrder.length > 0))) {
          applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, symbol, exchange, tf, 'history-flush', eventsRef)
        }
        checkTailInvariant(candlesDataRef, eventsRef, symbol, exchange, tf, 'history-flush')
      }
    }

    const run = async () => {
      // Reconcile: buffer live events while the history loads.
      eventsRef?.current?.setBuffered(true)

      let cached = candleCache.getCandles(exchange, symbol, tf)
      if (!cached?.length) {
        cached = await candleCache.hydratePersistentCandles(exchange, symbol, tf)
        if (cancelled.value || destroyedRef.current) {
          eventsRef?.current?.setBuffered(false)
          return
        }
      }
      // SWR-style partial paint: ANY non-empty cache paints immediately (chart
      // visible at once, live WS events replay on top), then the fetch below
      // tops up to the full requested depth in the background. Previously a
      // cache with fewer than `limit` candles was discarded entirely, forcing
      // a full network wait on every return to a chart. When a candles-recent
      // push landed (recentVersion > 0), even a handful of candles is enough
      // for the first paint — the server answered the subscription from its
      // cache, so the chart draws from the socket instead of the REST round-trip.
      if (cached && canPaintPartialHistory(cached.length)) {
        if (!cancelled.value && !destroyedRef.current) {
          renderCandles(cached)
          setIsInitialLoading(false)
          setStatus('ready')
          if (lastUpdateRef) lastUpdateRef.current = Date.now()
        }
        if (cached.length >= limit) return
      }

      const loadPlan = resolveHistoryLoadPlan({
        cachedCount: cached?.length ?? 0,
        initialLimit,
        targetLimit: limit,
      })
      const firstRequestLimit = loadPlan[0]
      if (firstRequestLimit !== undefined && firstRequestLimit < limit) {
        try {
          const tail = await getOrFetchHistory(symbol, tf, firstRequestLimit, exchange, forceServer)
          if (tail.length > 0 && !cancelled.value && !destroyedRef.current) {
            renderCandles(tail)
            setIsInitialLoading(false)
            setStatus('ready')
            if (lastUpdateRef) lastUpdateRef.current = Date.now()
          }
        } catch { /* deep request below remains the recovery path */ }
      }

      // Fetch with a hard deadline + bounded retries. Transient failures
      // (5xx/timeout from the server, exchange throttle) retry within the
      // deadline; afterwards the buffer is released so live events keep
      // painting and ONE background retry heals the history — the chart can
      // never be stuck blank until a page reload.
      const deadline = Date.now() + HISTORY_LOAD_DEADLINE_MS
      let fetched: UnifiedCandle[] = []
      let transientFailure = false
      let attempts = 0
      while (Date.now() < deadline) {
        attempts++
        try {
          fetched = await getOrFetchHistory(symbol, tf, limit, exchange, forceServer)
          transientFailure = false
          if (fetched.length > 0 || !transientFailure || attempts >= 3) break
        } catch {
          transientFailure = true
          if (attempts >= 3 || cancelled.value || destroyedRef.current) break
        }
        if (cancelled.value || destroyedRef.current) {
          eventsRef?.current?.setBuffered(false)
          return
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await new Promise(r => setTimeout(r, Math.min(300, remaining)))
      }

      if (cancelled.value || destroyedRef.current) {
        eventsRef?.current?.setBuffered(false)
        return
      }
      if (fetched.length > 0) {
        renderCandles(fetched)
        setIsInitialLoading(false)
        setStatus('ready')
        if (lastUpdateRef) lastUpdateRef.current = Date.now()
        // Convergence: the server may have SWR-served a shallow cache (its
        // background refresh was throttled). Top up to the full requested
        // depth with a bounded follow-up loop — the expanded chart must end
        // up with 3000 bars, not 300. Each attempt is cheap (server cache);
        // a repaint only happens when the depth actually improved.
        if (fetched.length < limit) {
          let attempts = 0
          const topUp = () => {
            if (cancelled.value || destroyedRef.current || attempts >= 3) return
            attempts++
            getOrFetchHistory(symbol, tf, limit, exchange, forceServer)
              .then(data => {
                if (cancelled.value || destroyedRef.current) return
                if (data.length > candlesDataRef.current.length && data.length > 0) {
                  renderCandles(data)
                  if (lastUpdateRef) lastUpdateRef.current = Date.now()
                }
                if (data.length < limit) setTimeout(topUp, 2500)
              })
              .catch(() => setTimeout(topUp, 5000))
          }
          setTimeout(topUp, 2500)
        }
        return
      }
      if (transientFailure) {
        // Nothing painted and the server is having a bad moment: release the
        // buffer so the forming candle can still paint from live events, and
        // retry once in the background.
        eventsRef?.current?.setBuffered(false)
        setIsInitialLoading(false)
        setStatus('retrying')
        setTimeout(() => {
          if (cancelled.value || destroyedRef.current) return
          getOrFetchHistory(symbol, tf, limit, exchange, forceServer)
            .then(data => {
              if (data.length > 0 && !cancelled.value && !destroyedRef.current) {
                renderCandles(data)
                setStatus('ready')
                if (lastUpdateRef) lastUpdateRef.current = Date.now()
              }
            })
            .catch(() => {})
        }, 5000)
        return
      }
      // Server answered without candles (or every attempt failed cleanly):
      // release the buffer so the forming candle can still paint from live
      // events.
      eventsRef?.current?.setBuffered(false)
      setIsInitialLoading(false)
      setStatus('empty')
    }

    run()
    return () => { cancelled.value = true }
    // `chartVersion` re-paints history when the canvas/series is recreated
    // (pricePrecision flip) — the new chart starts empty.
    // `wsEpoch` (the force-server token) re-paints after a WS reconnect so
    // periods that fell through the dead window are restored from the server.
  }, [symbol, exchange, tf, chartVersion, forceServerToken, limit, initialLimit, fitOnOpen, visibleBars, recentVersion,
    candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, lastUpdateRef, eventsRef])

  return { isInitialLoading, status, dataVersion }
}

function useLazyScroll(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  isInitialLoading: boolean,
  adjustingRef: React.RefObject<boolean>,
  setIsLoadingMore?: (loading: boolean) => void,
  eventsRef?: React.RefObject<CandleEvents | null>,
  onLogicalShift?: (added: number) => void,
) {
  const inflightRef = useRef(false)
  const reachedStartRef = useRef(false)
  const symbolRef = useRef(symbol)
  const exchangeRef = useRef(exchange)
  const tfRef = useRef(tf)
  const emptyCountRef = useRef(0)
  const onLogicalShiftRef = useRef(onLogicalShift)
  const setIsLoadingMoreRef = useRef(setIsLoadingMore)
  const lastCallTimeRef = useRef(0)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRangeRef = useRef<{ from: number; to: number } | null>(null)

  useEffect(() => {
    symbolRef.current = symbol
    exchangeRef.current = exchange
    tfRef.current = tf
    reachedStartRef.current = false
    inflightRef.current = false
    adjustingRef.current = false
    emptyCountRef.current = 0
    onLogicalShiftRef.current = onLogicalShift
    setIsLoadingMoreRef.current = setIsLoadingMore
  }, [symbol, exchange, tf, adjustingRef, onLogicalShift, setIsLoadingMore])

  // Throttle instead of debounce: first call fires immediately, subsequent
  // calls within 100ms are suppressed but the last one is replayed.
  const onRange = useMemo(() => {

    const fire = (range: { from: number; to: number } | null) => {
      if (!range || adjustingRef.current || inflightRef.current || reachedStartRef.current) return

      const curSymbol = symbolRef.current
      const curExchange = exchangeRef.current
      const curTf = tfRef.current
      if (!curExchange) return

      // Scalpboard's pagination trigger (their I()): fetch the older page
      // once the user crosses the LEFT EDGE of the loaded data (from < -10).
      // Before that the loaded history fully covers the viewport.
      if (range.from >= -10) return

      inflightRef.current = true
      setIsLoadingMoreRef.current?.(true)
      // Reconcile: buffer live events for the whole fetch+prepend window.
      eventsRef?.current?.setBuffered(true)

      const paint = (merged: UnifiedCandle[]) => {
        const chart = chartRef.current
        const ts = chart?.timeScale()
        if (!chart || !ts || destroyedRef.current) {
          eventsRef?.current?.setBuffered(false)
          return
        }
        // Capture BEFORE setData — prepending shifts every logical index.
        const prevLogical = ts.getVisibleLogicalRange()
        const prevLen = candlesDataRef.current.length
        const added = merged.length - prevLen

        if (added <= 0) {
          const flush = eventsRef?.current?.setBuffered(false)
          if (flush && (flush.updates.length > 0 || (flush.outOfOrder && flush.outOfOrder.length > 0))) {
            applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush', eventsRef)
          }
          checkTailInvariant(candlesDataRef, eventsRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush')
          return
        }

        adjustingRef.current = true
        try {
          candlesDataRef.current = merged
          // Prepend replaces everything — stop any pending forming-candle
          // glide so it can't paint stale interpolated values.
          stopFormingGlide(candleRef)
          const lineMode = useChartSettings.getState().candlesType === 'line'
          const candleData = lineMode
            ? merged.map(c => ({ time: toChartTime(c.time) as Time, value: c.close }))
            : merged.map(c => ({
                time: toChartTime(c.time) as Time, open: c.open, high: c.high, low: c.low, close: c.close,
              }))
          const volumeData = merged.map(c => ({
            time: toChartTime(c.time) as Time, value: c.volume,
          }))
          onLogicalShiftRef.current?.(added)
          replaceDataPreservingPriceScale(chart, () => {
            candleRef.current?.setData(candleData)
            volumeRef.current?.setData(volumeData)
          })
          // End reconciliation: replay any live events captured since the
          // fetch started ON TOP of the merged history.
          const flush = eventsRef?.current?.setBuffered(false)
          if (flush && (flush.updates.length > 0 || (flush.outOfOrder && flush.outOfOrder.length > 0))) {
            applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush', eventsRef)
          }
          checkTailInvariant(candlesDataRef, eventsRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush')
        } catch (err) {
          console.error('[ChartGrid] setData failed during lazy scroll', { symbol: curSymbol, tf: curTf, error: err })
          eventsRef?.current?.setBuffered(false)
        } finally {
          adjustingRef.current = false
        }
        // Restore by logical range shifted by `added` — the exact same bars
        // land at the exact same pixels as before the prepend.
        if (prevLogical) {
          try {
            ts.setVisibleLogicalRange({ from: prevLogical.from + added, to: prevLogical.to + added })
            // setVisibleLogicalRange can throw while the time scale is mid-sync;
            // the next range event re-syncs the view.
          } catch { /* benign: next visible-range event re-syncs */ }
        }
      }

      const cached = candleCache.getCandles(curExchange, curSymbol, curTf)
      if (!cached || cached.length === 0) {
        inflightRef.current = false
        setIsLoadingMoreRef.current?.(false)
        eventsRef?.current?.setBuffered(false)
        return
      }

      const before = cached[0].time
      getOrFetchOlder(curSymbol, curTf, before, 1000, curExchange)
        .then(older => {
          if (destroyedRef.current) {
            inflightRef.current = false
            setIsLoadingMoreRef.current?.(false)
            eventsRef?.current?.setBuffered(false)
            return
          }
          const newCandles = older.filter(c => c.time < before)
          if (newCandles.length === 0) {
            emptyCountRef.current++
            if (emptyCountRef.current >= 3) {
              reachedStartRef.current = true
            }
            inflightRef.current = false
            setIsLoadingMoreRef.current?.(false)
            const flush = eventsRef?.current?.setBuffered(false)
            if (flush && (flush.updates.length > 0 || (flush.outOfOrder && flush.outOfOrder.length > 0))) {
              applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush', eventsRef)
            }
            checkTailInvariant(candlesDataRef, eventsRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush')
            return
          }

          emptyCountRef.current = 0
          candleCache.prependCandles(curExchange, curSymbol, curTf, newCandles)
          const merged = candleCache.getCandles(curExchange, curSymbol, curTf)
          if (!merged || merged.length === 0) {
            inflightRef.current = false
            setIsLoadingMoreRef.current?.(false)
            eventsRef?.current?.setBuffered(false)
            return
          }

          // scalpboard's Mn(): full setData with the merged array.
          paint(merged)
          inflightRef.current = false
          setIsLoadingMoreRef.current?.(false)
        })
        .catch((err: Error & { isNetworkError?: boolean }) => {
          // Network error — NOT end of history: stay ready to retry.
          if (!err?.isNetworkError) {
            emptyCountRef.current++
            if (emptyCountRef.current >= 3) {
              reachedStartRef.current = true
            }
          }
          inflightRef.current = false
          setIsLoadingMoreRef.current?.(false)
          const flush = eventsRef?.current?.setBuffered(false)
          if (flush && (flush.updates.length > 0 || (flush.outOfOrder && flush.outOfOrder.length > 0))) {
            applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush', eventsRef)
          }
          checkTailInvariant(candlesDataRef, eventsRef, curSymbol, curExchange, curTf, 'lazy-scroll-flush')
        })
    }

    const throttled = (range: { from: number; to: number } | null) => {
      if (!range) { fire(null); return }
      const now = Date.now()
      if (now - lastCallTimeRef.current >= 100) {
        lastCallTimeRef.current = now
        if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null }
        fire(range)
      } else {
        pendingRangeRef.current = range
        if (!pendingTimerRef.current) {
          pendingTimerRef.current = setTimeout(() => {
            pendingTimerRef.current = null
            lastCallTimeRef.current = Date.now()
            fire(pendingRangeRef.current)
            pendingRangeRef.current = null
          }, 100 - (now - lastCallTimeRef.current))
        }
      }
    }

    return throttled
  }, [adjustingRef, candleRef, candlesDataRef, chartRef, destroyedRef, eventsRef, volumeRef])

  useEffect(() => {
    if (isInitialLoading) return
    const chart = chartRef.current
    if (!chart) return
    const ts = chart.timeScale()

    ts.subscribeVisibleLogicalRangeChange(onRange)
    return () => { ts.unsubscribeVisibleLogicalRangeChange(onRange) }
  }, [symbol, tf, isInitialLoading, onRange, chartRef])
}

function useStaleDataDetection(
  lastUpdateRef: React.RefObject<number>,
  threshold = 30000 // Увеличено до 30 секунд для низколиквидных пар
): boolean {
  const [isStale, setIsStale] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => {
      const last = lastUpdateRef.current
      // lastUpdate === 0 means "never received anything yet" — not stale.
      const elapsed = last > 0 ? Date.now() - last : 0
      // A quiet pair can legitimately go 30s+ without a trade/kline while the
      // connection is perfectly healthy (its chart is still fed by the price
      // lane). The "reconnecting" overlay must only appear when the GLOBAL
      // feed is silent too — the server broadcasts tickers to every client at
      // ~25Hz, so a live socket always has a fresh global timestamp.
      const globalSilent = Date.now() - getWsLastMessageAt() > threshold
      const shouldBeStale = elapsed > threshold && globalSilent
      setIsStale(shouldBeStale)
    }, 1000)

    return () => clearInterval(interval)
  }, [threshold, lastUpdateRef])

  return isStale
}

function useWsCandle(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  eventsRef: React.RefObject<CandleEvents | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
  lastUpdateRef?: React.RefObject<number>,
) {
  useEffect(() => {
    if (!exchange) return
    const channel = `candle:${exchange}:${symbol}:${tf}`
    const unsub = wsOnChannel(channel, (msg) => {
      if (destroyedRef.current) return
      // Skip non-candle frames on this channel (candles-recent pushes carry the
      // same channel but a different type).
      if ((msg as { type?: string }).type !== channel) return

      const c = msg.data as UnifiedCandle
      if (!c) return

      if (lastUpdateRef) {
        lastUpdateRef.current = Date.now()
      }

      if (!isFiniteOHLCV(c)) return

      const ev = eventsRef.current
      if (!ev) return

      // kline snapshot → FULL replace of the bar (scalpboard's Cn).
      const patch = ev.applyKline(c)
      if (adjustingRef?.current) {
        // Atomicity invariant (Stage 2 item 1): `adjustingRef` is only ever
        // set true INSIDE a window where the events layer's own buffer is
        // already held open (useLazyScroll calls setBuffered(true) before
        // the fetch and only sets adjustingRef true within that window), so
        // `ev.applyKline` above should have queued this event rather than
        // mutating the tail — `patch` should be EMPTY_PATCH(). If it isn't
        // (a future refactor decoupled the two flags), the event's tail
        // already advanced but is about to be silently dropped here instead
        // of replayed on flush — log it loudly instead of losing it quietly.
        if (patch.updates.length > 0 || (patch.outOfOrder && patch.outOfOrder.length > 0)) {
          recordDiag('adjusting_drop_unbuffered', {
            symbol, exchange, tf, from: c.time,
            detail: 'kline mutated events tail while adjustingRef was true but buffer was NOT held — event lost',
          })
        }
        return
      }

      applyChartPatch(patch, candleRef, volumeRef, candlesDataRef, symbol, exchange, tf, 'kline', eventsRef)
      checkTailInvariant(candlesDataRef, eventsRef, symbol, exchange, tf, 'kline')
    })
    wsSubscribe(channel)
    return () => {
      unsub()
      wsUnsubscribe(channel)
    }
  }, [symbol, exchange, tf, adjustingRef, candleRef, candlesDataRef, destroyedRef, eventsRef, lastUpdateRef, volumeRef])
}

/**
 * Price precision for a chart's displays, resolved to the CHART's exchange —
 * the same tick grid the стакан (order book) is built on. coinMap is keyed by
 * symbol and keeps the highest-priority exchange entry, so for a symbol not
 * listed on the chart exchange it would leak a foreign venue's tick (BTC
 * futures 0.1 vs spot 0.01) — the source of the "rounded differently than the
 * стакан" look. The per-exchange master list is consulted first; falls back
 * to coinMap, then 2.
 */
/**
 * Per-coins-array index of `${symbol}:${exchange}` → coin. The precision
 * selector ran `s.coins.find(...)` — a full linear scan — on EVERY store
 * notification × every mounted chart (10 charts × ~1200 tickers × up to 25Hz).
 * The coins array reference only changes when its contents change, so the
 * index is cached against THAT reference (WeakMap → GC'd with the array).
 */
const exCoinIndexCache = new WeakMap<UnifiedTicker[], Map<string, UnifiedTicker>>()
function getExCoinIndex(coins: UnifiedTicker[]): Map<string, UnifiedTicker> {
  let m = exCoinIndexCache.get(coins)
  if (!m) {
    m = new Map()
    for (const c of coins) m.set(`${c.symbol}:${c.exchange}`, c)
    exCoinIndexCache.set(coins, m)
  }
  return m
}

function useCoinPrecision(symbol: string, exchange?: string): number {
  return useCoinListStore(s => {
    const coin = s.coinMap.get(symbol)
    if (coin && (!exchange || coin.exchange === exchange)) return coin.pricePrecision ?? 2
    if (exchange) {
      const byEx = getExCoinIndex(s.coins).get(`${symbol}:${exchange}`)
      if (byEx && typeof byEx.pricePrecision === 'number') return byEx.pricePrecision
    }
    return coin?.pricePrecision ?? 2
  })
}

function useWsTrade(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  eventsRef: React.RefObject<CandleEvents | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
  lastUpdateRef?: React.RefObject<number>,
) {
  // Executed trades are the only price ticks allowed to mutate candle OHLC.
  // Bid/ask midpoint is a quote, not a trade; it intentionally stays outside
  // this chart event path so sparse markets cannot manufacture highs/lows.

  useEffect(() => {
    if (!exchange) return
    const tradeType = `trade:${exchange}:${symbol}`

    const unsub = wsOnType(tradeType, (msg) => {
      if (destroyedRef.current) return

      const trade = (msg as { data?: { price: string | number; time?: number; volume?: string | number } | null }).data
      if (!trade?.price) return

      if (lastUpdateRef) {
        lastUpdateRef.current = Date.now()
      }
      const price = typeof trade.price === 'number' ? trade.price : parseFloat(trade.price)
      if (!isFinite(price)) return

      // Defensive floor (Stage 2 item 6): the server's aggTrade payload sends
      // `data.T / 1000` — a bare division, not a floor — so `trade.time` can
      // arrive as a fractional epoch-seconds value (e.g. 1712345678.123).
      // Flooring here once, at the ingestion boundary, keeps every downstream
      // consumer working with whole-second times.
      const tradeTime = typeof trade.time === 'number' && isFinite(trade.time)
        ? Math.floor(trade.time)
        : Math.floor(Date.now() / 1000)

      const ev = eventsRef.current
      if (!ev) return

      // Liveness lane: even when the print falls OUTSIDE the current bar's
      // period window (the next period hasn't been opened by a kline yet),
      // the trade itself is real. Feed the price lanes directly so chart
      // headers and stale-data detection keep moving on quiet pairs instead
      // of freezing until the next kline. OHLC is NEVER touched here — bars
      // still come only from klines/ticks inside their own window.
      setLivePrice(symbol, price)
      if (exchange) setLivePriceEx(symbol, exchange, price)

      // Price tick → mutate ONLY the last bar's close/high/low (scalpboard's
      // En). Volume never comes from trades.
      const patch = ev.applyTick({ price, timeSec: tradeTime, source: 'trade' } as TickPayload)
      if (adjustingRef?.current) {
        if (patch.updates.length > 0 || (patch.outOfOrder && patch.outOfOrder.length > 0)) {
          recordDiag('adjusting_drop_unbuffered', {
            symbol, exchange, tf, from: tradeTime,
            detail: 'trade tick mutated events tail while adjustingRef was true but buffer was NOT held — event lost',
          })
        }
        return
      }

      applyChartPatch(patch, candleRef, volumeRef, candlesDataRef, symbol, exchange, tf, 'tick-trade', eventsRef)
      checkTailInvariant(candlesDataRef, eventsRef, symbol, exchange, tf, 'tick-trade')
    })
    wsSubscribe(tradeType)

    return () => {
      unsub()
      wsUnsubscribe(tradeType)
    }
  }, [symbol, exchange, tf, adjustingRef, candleRef, candlesDataRef, destroyedRef, eventsRef, lastUpdateRef, volumeRef])
}


function exchangeBadge(ex: string): string {
  if (ex.includes('binance') && ex.includes('futures')) return 'BI-F'
  if (ex.includes('binance') && ex.includes('spot')) return 'BI-S'
  if (ex.includes('bybit')) return 'BY-F'
  if (ex.includes('okx') && ex.includes('futures')) return 'OK-F'
  if (ex.includes('okx') && ex.includes('spot')) return 'OK-S'
  return 'EX'
}

const MiniChartHeader = memo(function MiniChartHeader({ symbol, chartExchange }: { symbol: string; chartExchange: ChartExchange }) {
  const coin = useCoinListStore(useShallow(s => {
    const c = s.coinMap.get(symbol)
    if (!c) return null
    return {
      exchange: c.exchange,
      change24h: c.change24h,
      quoteVolume24h: c.quoteVolume24h,
      natr5m: c.natr5m,
      range1m: c.range1m,
      corrBtc: c.corrBtc,
      tradesSpike: c.tradesSpike,
      volumeSpike: c.volumeSpike,
    }
  }))
  const settings = useAuthStore(s => s.settings)
  const chartHeader = useMemo(() => resolveIndicators(settings?.indicators).chartHeader, [settings])

  const isUp = coin ? coin.change24h >= 0 : true
  const badge = exchangeBadge(chartExchange)
  const vol = coin ? formatCompact(coin.quoteVolume24h) : '-'

  return (
    <div className="relative z-20 flex items-center justify-between px-[6px] py-[3px] border-b border-[#1f1f1f] flex-shrink-0 gap-2 bg-[#141414]">
      <div className="flex items-center gap-[5px] min-w-0">
        <span className="text-[9px] font-bold leading-none text-[#b3b3b3]">
          {badge}
        </span>
        <span className="font-bold text-[11px] text-[#e0e0e0] truncate">
          {extractBaseAsset(symbol)}
        </span>
      </div>
      <div className="flex items-center gap-[6px] flex-shrink-0">
        {coin && chartHeader.map(key => {
          if (key === 'change24h') {
            return (
              <span key={key} className={`font-mono font-bold text-[10px] ${isUp ? 'text-[#26a65b]' : 'text-[#e74c3c]'}`}>
                {isUp ? '+' : ''}{coin.change24h.toFixed(1)}%
              </span>
            )
          }
          if (key === 'quoteVolume24h') {
            return <span key={key} className="font-mono text-[10px] text-[#888]">{vol}</span>
          }
          const value = coin[key]
          const isSpike = (key === 'tradesSpike' || key === 'volumeSpike') && typeof value === 'number' && value >= 2
          return (
            <span key={key} className={`font-mono text-[10px] ${isSpike ? 'text-[#f5c518] font-bold' : 'text-[#888]'}`}>
              {formatIndicator(key, value)}
            </span>
          )
        })}
      </div>
    </div>
  )
})

const MiniChart = memo(function MiniChart({
  symbol, chartExchange,
}: { symbol: string; chartExchange: ChartExchange }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const pricePrecision = useCoinPrecision(symbol, chartExchange)
  const exchange: Exchange | undefined = chartExchange
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const lastUpdateRef = useRef(0)
  const [chartVersion, setChartVersion] = useState(0)
  const [selection, setSelection] = useState<RangeSelection | null>(null)

  const eventsRef = useRef<CandleEvents | null>(null)

  useEffect(() => {
    if (exchange) {
      eventsRef.current?.destroy()
      eventsRef.current = createCandleEvents({
        symbol, exchange, tf, tfSeconds: getTfSeconds(tf),
      })
    }
    return () => { eventsRef.current?.destroy() }
  }, [symbol, exchange, tf])

  const isStale = useStaleDataDetection(lastUpdateRef)

  const baseSettings = useChartSettings()
  const settingsRef = useRef(baseSettings)
  useEffect(() => {
    settingsRef.current = baseSettings
  })

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return
    const s = settingsRef.current

    const base = buildChartOptions(s, { top: 0.1, bottom: 0.25 })
    const chart = createChart(containerRef.current, {
      ...base,
      handleScroll: true,
      // Mouse-drag inertia OFF — the chart stops exactly where the mouse is
      // released (inertia felt like the chart "flying away"). Touch stays
      // off too. Lazy-scroll pagination is throttled at 100ms with an
      // inflight guard, so range events can't flood the server.
      kineticScroll: { touch: false, mouse: false },
    })

    const seriesOpts = candleSeriesOptions(s)
    const candleSeries = s.candlesType === 'line'
      ? chart.addSeries(LineSeries, seriesOpts as DeepPartial<LineSeriesOptions>)
      : s.candlesType === 'bars'
        ? chart.addSeries(BarSeries, seriesOpts as DeepPartial<BarSeriesOptions>)
        : chart.addSeries(CandlestickSeries, seriesOpts as DeepPartial<CandlestickSeriesOptions>)
    candleSeries.applyOptions({
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { ...volumeSeriesOptions(), priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: volumePaneTop(s.volumesHeight), bottom: 0 }, textColor: '#666666' })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries

    setChartVersion(v => v + 1)

    let prevW = containerRef.current.clientWidth
    let prevH = containerRef.current.clientHeight
    const ro = new ResizeObserver(() => {
      if (containerRef.current && !destroyedRef.current) {
        const w = containerRef.current.clientWidth
        const h = containerRef.current.clientHeight
        if (w < 10 || h < 10) return
        if (w === prevW && h === prevH) return
        prevW = w
        prevH = h
        chart.applyOptions({ width: w, height: h })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      destroyedRef.current = true
      ro.disconnect()
      // Explicitly stop any pending forming-candle glide (Stage 2 item 3:
      // "Отменять rAF при setData, смене tf/символа, destroy"). The
      // WeakMap-keyed animator would otherwise only stop lazily on its next
      // rAF tick (once `getRef()` returns null and its `tick()` returns
      // false) — up to one frame of `series.update()` calls against a
      // series that's about to be removed. Calling reset() here unregisters
      // it from the shared rAF coordinator synchronously, before
      // chart.remove() disposes the series.
      stopFormingGlide(candleRef)
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
    // NB: `tf` is deliberately NOT a dependency — a timeframe switch only
    // needs new data (useFullHistory handles setData + visible range), not a
    // full chart destroy/recreate. `candlesType` DOES trigger a recreate —
    // the series construction differs per style.
  }, [symbol, pricePrecision, baseSettings.candlesType])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = useChartSettings.getState()
    chart.applyOptions({
      rightPriceScale: { mode: s.priceScaleMode === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal },
      grid: { vertLines: { visible: s.vertGrid }, horzLines: { visible: s.horzGrid } },
      timeScale: { timeVisible: timeVisibleFor(s.interval), secondsVisible: secondsVisibleFor(s.interval), barSpacing: s.barSpace, rightOffset: s.rightOffset },
    })
    chart.priceScale('').applyOptions({ scaleMargins: { top: volumePaneTop(s.volumesHeight), bottom: 0 } })
  }, [baseSettings.priceScaleMode, baseSettings.vertGrid, baseSettings.horzGrid, baseSettings.interval, baseSettings.barSpace, baseSettings.rightOffset, baseSettings.volumesHeight])

  const [wsCount, setWsCount] = useState(getWsOpenCount)
  useEffect(() => {
    const un = wsOnType('open', () => setWsCount(getWsOpenCount()))
    return un
  }, [])

  const [recentVersion, setRecentVersion] = useState(0)
  const bumpRecentVersion = useCallback(() => setRecentVersion(v => v + 1), [])

  const { isInitialLoading, status, dataVersion } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, {
    limit: GRID_CANDLE_LIMIT,
    wsEpoch: wsCount,
    recentVersion,
  }, lastUpdateRef, eventsRef, chartVersion)

  const adjustingRef = useRef(false)

  const {
    activeTool,
    removeDrawing,
    handleClick: drawingClickHandler,
    handleMouseDown: drawingMouseDownHandler,
    handleMouseMove: drawingMouseMoveHandler,
    handleMouseUp: drawingMouseUpHandler,
    deactivateTool,
    primitiveRef,
    isDraggingRef,
    shiftLogicalOffset,
    CLICK_THRESHOLD,
  } = useDrawings(symbol, tf, chartRef, candleRef, containerRef, candlesDataRef, chartVersion, isInitialLoading, dataVersion)

  useChartOverlays(candleRef, candlesDataRef, dataVersion, chartVersion, pricePrecision)
  useDensityOverlay(candleRef, chartVersion, symbol, pricePrecision)

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useCandlesRecent(symbol, exchange, tf, bumpRecentVersion)
  useLazyScroll(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, undefined, eventsRef, shiftLogicalOffset)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let mouseDownX = 0
    let mouseDownY = 0
    let restoreOpts: { handleScroll?: boolean; handleScale?: boolean } | null = null
    let selDragging = false
    let selStartX = 0
    let selStartY = 0
    let selRaf: number | null = null

    const disableScroll = () => {
      const chart = chartRef.current
      if (!chart) return
      restoreOpts = { handleScroll: true, handleScale: true }
      chart.applyOptions({ handleScroll: false, handleScale: false })
    }

    const restoreDrawingScroll = () => {
      const chart = chartRef.current
      if (chart && restoreOpts) {
        chart.applyOptions(restoreOpts)
        restoreOpts = null
      }
    }

    const computeSelection = (curX: number, curY: number): RangeSelection => {
      const chart = chartRef.current
      const series = candleRef.current
      const x1 = Math.min(selStartX, curX)
      const x2 = Math.max(selStartX, curX)
      let startPrice = 0
      let endPrice = 0
      let changePct = 0
      let durationSec = 0
      let valid = false

      if (chart && series) {
        const pStart = series.coordinateToPrice(selStartY) as number | null
        const pEnd = series.coordinateToPrice(curY) as number | null

        if (pStart !== null && pEnd !== null && isFinite(pStart) && isFinite(pEnd) && pStart > 0) {
          startPrice = pStart
          endPrice = pEnd
          changePct = ((endPrice - startPrice) / startPrice) * 100
          valid = true
        }

        const t1Raw = chart.timeScale().coordinateToTime(x1) as number | null
        const t2Raw = chart.timeScale().coordinateToTime(x2) as number | null
        const t1Num = (t1Raw == null || typeof t1Raw === 'number')
          ? t1Raw as number | null
          : null
        const t2Num = (t2Raw == null || typeof t2Raw === 'number')
          ? t2Raw as number | null
          : null

        if (t1Num !== null && t2Num !== null) {
          durationSec = Math.abs(t2Num - t1Num)
        }
      }

      const box = containerRef.current
      const boxW = box?.clientWidth ?? 9999
      const boxH = box?.clientHeight ?? 9999
      const tooltipLeft = Math.min(Math.max(curX + 10, 0), boxW - 180)
      const tooltipTop = Math.min(Math.max(curY + 10, 0), boxH - 70)

      return {
        startX: selStartX,
        startY: selStartY,
        endX: curX,
        endY: curY,
        startPrice,
        endPrice,
        changePct,
        durationSec,
        valid,
        tooltipLeft,
        tooltipTop,
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      // Shift+ЛКМ or middle-click (Колёсико) — select a region to measure %
      // (same gestures as the expanded chart).
      if ((e.button === 0 && e.shiftKey) || e.button === 1) {
        const rect = container.getBoundingClientRect()
        selStartX = e.clientX - rect.left
        selStartY = e.clientY - rect.top
        selDragging = true
        e.preventDefault()
        disableScroll()
        setSelection(computeSelection(selStartX, selStartY))
        return
      }

      if (e.button !== 0) return

      if (activeTool !== null) {
        mouseDownX = e.clientX - container.getBoundingClientRect().left
        mouseDownY = e.clientY - container.getBoundingClientRect().top
        disableScroll()
      } else {
        drawingMouseDownHandler(e)
        if (isDraggingRef.current) {
          disableScroll()
        }
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      drawingMouseMoveHandler(e)

      if (!selDragging) return
      const rect = container.getBoundingClientRect()
      const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height))
      if (selRaf != null) return
      selRaf = requestAnimationFrame(() => {
        selRaf = null
        if (!selDragging) return
        setSelection(computeSelection(curX, curY))
      })
    }

    const onMouseUp = (e: MouseEvent) => {
      if (selDragging) {
        selDragging = false
        if (selRaf != null) { cancelAnimationFrame(selRaf); selRaf = null }
        restoreDrawingScroll()
        setSelection(null)
        return
      }

      if (e.button !== 0) return

      const wasDragging = isDraggingRef.current
      const toolActive = activeTool !== null

      if (wasDragging) {
        drawingMouseUpHandler(e)
        restoreDrawingScroll()
      }

      if (toolActive && !wasDragging) {
        restoreDrawingScroll()
        const rect = container.getBoundingClientRect()
        const upX = e.clientX - rect.left
        const upY = e.clientY - rect.top
        const dx = Math.abs(upX - mouseDownX)
        const dy = Math.abs(upY - mouseDownY)
        if (dx < CLICK_THRESHOLD && dy < CLICK_THRESHOLD) {
          drawingClickHandler(e)
        }
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null)
        selDragging = false
        if (selRaf != null) { cancelAnimationFrame(selRaf); selRaf = null }
        restoreDrawingScroll()
        deactivateTool()
      }
    }

    container.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      container.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      restoreDrawingScroll()
      selDragging = false
      if (selRaf != null) cancelAnimationFrame(selRaf)
    }
  }, [activeTool, drawingClickHandler, drawingMouseDownHandler, drawingMouseMoveHandler, drawingMouseUpHandler, deactivateTool, isDraggingRef, CLICK_THRESHOLD])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      const primitive = primitiveRef.current
      if (!primitive) return
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const hit = primitive.hitTest?.(x, y)
      if (hit) {
        removeDrawing(hit.externalId)
      }
    }
    container.addEventListener('contextmenu', onCtx)
    // Middle-click is consumed by the %-measure selection on mousedown —
    // block the browser's autoscroll on auxclick too (expanded-chart parity).
    const onAuxclick = (e: MouseEvent) => { if (e.button === 1) e.preventDefault() }
    container.addEventListener('auxclick', onAuxclick)
    return () => {
      container.removeEventListener('contextmenu', onCtx)
      container.removeEventListener('auxclick', onAuxclick)
    }
  }, [primitiveRef, removeDrawing])

  return (
  <div className="relative flex flex-col h-full bg-[#0e0e0e] border border-[#1f1f1f] overflow-hidden rounded-[3px]">
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 select-none">
      <span className="text-[48px] font-bold text-white/[0.04] tracking-tighter uppercase">
        {extractBaseAsset(symbol)}
      </span>
    </div>
    <MiniChartHeader symbol={symbol} chartExchange={chartExchange} />
    <div
      ref={containerRef}
      className={`relative z-0 flex-1 min-h-0 [transform:translateZ(0)] [backface-visibility:hidden] [contain:paint] transition-opacity duration-300 ease-out ${
        isInitialLoading ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {isStale && <StaleDataOverlay visible={true} />}
      {selection && Math.abs(selection.endX - selection.startX) > 2 && (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div
            className={`absolute border ${
              selection.valid && selection.changePct >= 0
                ? 'border-[#26a65b]/70 bg-[#26a65b]/10'
                : selection.valid
                  ? 'border-[#e74c3c]/70 bg-[#e74c3c]/10'
                  : 'border-[#f9b600]/70 bg-[#f9b600]/10'
            }`}
            style={{
              left: Math.min(selection.startX, selection.endX),
              top: Math.min(selection.startY, selection.endY),
              width: Math.abs(selection.endX - selection.startX),
              height: Math.max(2, Math.abs(selection.endY - selection.startY)),
            }}
          />
          <div
            className={`absolute px-[8px] py-[5px] rounded-[4px] text-[11px] font-mono bg-[#141414] border shadow-lg whitespace-nowrap ${
              !selection.valid
                ? 'border-[#3a3a3a] text-[#888]'
                : selection.changePct >= 0
                  ? 'border-[#26a65b] text-[#26a65b]'
                  : 'border-[#e74c3c] text-[#e74c3c]'
            }`}
            style={{
              left: selection.tooltipLeft,
              top: selection.tooltipTop,
            }}
          >
            {selection.valid ? (
              <>
                <div className="text-[13px] font-bold">
                  {selection.changePct >= 0 ? '+' : ''}
                  {selection.changePct.toFixed(2)}%
                </div>
                <div className="text-[10px] text-[#888] mt-[2px]">
                  ${formatPrice(selection.startPrice, pricePrecision)} → ${formatPrice(selection.endPrice, pricePrecision)}
                </div>
                <div className="text-[10px] text-[#666]">
                  {formatDuration(selection.durationSec)}
                </div>
              </>
            ) : (
              <span>Select a range</span>
            )}
          </div>
        </div>
      )}
    </div>
    {isInitialLoading && (
      <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
        <div className="w-[18px] h-[18px] border-2 border-[#333] border-t-[#999] rounded-full animate-spin" />
      </div>
    )}
    {!isInitialLoading && status === 'retrying' && <ChartCornerSpinner />}
    {status === 'empty' && <ChartMessageOverlay label="No data for this timeframe" />}
    {status === 'error' && <ChartMessageOverlay label="Error loading data" tone="error" />}
  </div>
)
})

type RangeSelection = {
  startX: number
  startY: number
  endX: number
  endY: number
  startPrice: number
  endPrice: number
  changePct: number
  durationSec: number
  valid: boolean
  /** Tooltip anchor pre-clamped to the container (computed in the handler). */
  tooltipLeft: number
  tooltipTop: number
}

function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0s'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

const TF_SETTINGS: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']

const WM_PLACE_OPTIONS: { value: WatermarkPlace; label: string }[] = [
  { value: 'center-center', label: 'Center' },
  { value: 'center-top', label: 'Top' },
  { value: 'center-bottom', label: 'Bottom' },
  { value: 'left-center', label: 'Left' },
  { value: 'right-center', label: 'Right' },
]

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[5px]">
      <span className="text-[11px] text-[#aaa] shrink-0 min-w-[90px]">{label}</span>
      <div className="flex items-center gap-1 flex-1 justify-end">{children}</div>
    </div>
  )
}

function SettingsSlider({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-[#f9b600]"
      />
      <span className="text-[10px] text-[#888] font-mono w-[34px] text-right tabular-nums">{value}</span>
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`px-[8px] py-[2px] rounded-[3px] border text-[11px] leading-none transition-colors ${
        checked ? 'border-[#f9b600]/60 bg-[#f9b600]/10 text-[#f9b600]' : 'border-[#333] bg-[#1a1a1a] text-[#888]'
      }`}
    >
      {label}
    </button>
  )
}

function ChartSettingsPanel() {
  const s = useChartSettings()
  const setSetting = useChartSettings(st => st.setSetting)
  const setTimeframe = useCoinListStore(st => st.setTimeframe)

  const changeInterval = (tf: Timeframe) => {
    setSetting('interval', tf)
    setTimeframe(tf)
  }

  return (
    <div className="fixed right-[12px] top-[100px] z-40 w-[320px] max-h-[70vh] overflow-y-auto rounded-[6px] border border-[#2a2a2a] bg-[#141414] shadow-[0_20px_50px_rgba(0,0,0,0.6)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-bold text-[#e0e0e0]">View</span>
        <button
          className="text-[10px] text-[#888] hover:text-[#ccc] px-[6px] py-[2px] rounded-[3px] border border-[#2a2a2a]"
          onClick={resetChartSettings}
        >
          Reset
        </button>
      </div>

      <SettingsRow label="Interval">
        <div className="flex gap-[2px]">
          {TF_SETTINGS.map(tf => (
            <button
              key={tf}
              className={`px-[6px] py-[2px] rounded-[3px] text-[10px] leading-none ${
                s.interval === tf ? 'bg-[#f9b600]/15 text-[#f9b600] border border-[#f9b600]/50' : 'text-[#999] border border-[#2a2a2a] hover:border-[#444]'
              }`}
              onClick={() => changeInterval(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
      </SettingsRow>

      <SettingsRow label="Candles">
        <div className="flex gap-[2px]">
          {(['default', 'bars', 'line'] as const).map(t => (
            <Toggle
              key={t}
              checked={s.candlesType === t}
              onChange={() => setSetting('candlesType', t)}
              label={t === 'default' ? 'Candles' : t === 'bars' ? 'Bars' : 'Line'}
            />
          ))}
        </div>
      </SettingsRow>

      <SettingsRow label="Volume">
        <SettingsSlider value={s.volumesHeight} min={3} max={50} step={1} onChange={v => setSetting('volumesHeight', v)} />
      </SettingsRow>

      <SettingsRow label="Offset">
        <SettingsSlider value={s.rightOffset} min={0} max={100} step={1} onChange={v => setSetting('rightOffset', v)} />
      </SettingsRow>

      <SettingsRow label="Density">
        <SettingsSlider value={s.barSpace} min={0.5} max={10} step={0.1} onChange={v => setSetting('barSpace', v)} />
      </SettingsRow>

      <SettingsRow label="Scale">
        <div className="flex gap-[2px]">
          <Toggle checked={s.priceScaleMode === 'default'} onChange={() => setSetting('priceScaleMode', 'default')} label="Normal" />
          <Toggle checked={s.priceScaleMode === 'log'} onChange={() => setSetting('priceScaleMode', 'log')} label="Log" />
        </div>
      </SettingsRow>

      <SettingsRow label="Grid">
        <>
          <Toggle checked={s.vertGrid} onChange={v => setSetting('vertGrid', v)} label="V" />
          <Toggle checked={s.horzGrid} onChange={v => setSetting('horzGrid', v)} label="H" />
        </>
      </SettingsRow>

      <div className="my-2 border-t border-[#222]" />

      <SettingsRow label="Mark">
        <SettingsSlider value={s.watermark} min={0} max={1} step={0.05} onChange={v => setSetting('watermark', v)} />
      </SettingsRow>

      <SettingsRow label="Size">
        <SettingsSlider value={s.watermarkSize} min={12} max={96} step={1} onChange={v => setSetting('watermarkSize', v)} />
      </SettingsRow>

      <SettingsRow label="Position">
        <select
          value={s.watermarkPlace}
          onChange={e => setSetting('watermarkPlace', e.target.value as WatermarkPlace)}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-[3px] text-[11px] text-[#ccc] px-[6px] py-[2px]"
        >
          {WM_PLACE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </SettingsRow>

      <SettingsRow label="Text">
        <input
          value={s.watermarkPattern}
          onChange={e => setSetting('watermarkPattern', e.target.value)}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-[3px] text-[11px] text-[#ccc] px-[6px] py-[2px] w-[150px] text-right font-mono"
        />
      </SettingsRow>

      <div className="mt-2 border-t border-[#222] pt-2">
        <div className="text-[10px] text-[#666] leading-[1.5]">
          Cascades — full configuration in the account
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Toggle checked={s.showTriggeredAlerts} onChange={v => setSetting('showTriggeredAlerts', v)} label="Alerts" />
      </div>

      <div className="mt-2 flex items-center gap-3">
        <Toggle checked={s.showDensities} onChange={v => setSetting('showDensities', v)} label="Density" />
      </div>

      <div className="mt-1 text-[10px] text-[#666]">{'{ticker}'} — ticker placeholder in the mark text</div>
    </div>
  )
}

const ExpandedChartHeader = memo(function ExpandedChartHeader({ symbol, onBack, activeTool, chartExchange }: { symbol: string; onBack: () => void; activeTool: DrawingTool | null; chartExchange: ChartExchange }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const coin = useCoinListStore(useShallow(s => {
    const c = s.coinMap.get(symbol)
    if (!c) return null
    return {
      exchange: c.exchange,
      change24h: c.change24h,
      price: c.price,
      quoteVolume24h: c.quoteVolume24h,
      high24h: c.high24h,
      low24h: c.low24h,
    }
  }))
  // Smoothed price display (presentation only — chart/store data stays exact).
  // Scoped to the chart's exchange so the header always shows THIS chart's
  // last print with THIS venue's tick precision — never the best-exchange
  // price or precision. Displayed values are snapped to the tick grid, so
  // every shown number exists as a стакан level.
  const precision = useCoinPrecision(symbol, chartExchange)
  const priceRef = useSmoothedPriceRef(symbol, precision, coin?.price, '$', chartExchange)
  const isUp = coin ? coin.change24h >= 0 : true
  const badge = exchangeBadge(chartExchange)
  const volDisplay = coin ? formatCompact(coin.quoteVolume24h) : '-'

  return (
    <div className="flex items-center gap-3 px-3 py-[6px] bg-[#141414] border-b border-[#1f1f1f] flex-shrink-0">
      <button
        className="clinic-btn clinic-btn-sm flex items-center justify-center w-[28px] h-[28px] p-0"
        onClick={onBack}
        title="Back to grid"
      >
        <ArrowLeft size={15} />
      </button>

      <div className="flex items-center gap-[8px] min-w-0">
        <span className="text-[10px] font-bold leading-none text-[#b3b3b3]">
          {badge}
        </span>
        <span className="font-bold text-[14px] text-[#f0f0f0] tracking-tight">
          {extractBaseAsset(symbol)}
        </span>
      </div>

      <div className="w-[1px] h-[20px] bg-[#1f1f1f] flex-shrink-0" />

      <div className="flex items-center gap-[6px]">
        <span className={`font-mono font-bold text-[13px] ${isUp ? 'text-[#26a65b]' : 'text-[#e74c3c]'}`}>
          {coin ? `${isUp ? '+' : ''}${coin.change24h.toFixed(2)}%` : ''}
        </span>
      </div>

      <span ref={priceRef} className="font-mono font-bold text-[13px] text-[#e0e0e0]" />

      <div className="w-[1px] h-[20px] bg-[#1f1f1f] flex-shrink-0" />

      <div className="flex items-center gap-[6px] text-[11px] text-[#888]">
        <span>H: <span className="font-mono text-[#b3b3b3]">{coin ? `$${formatPrice(coin.high24h, precision)}` : '-'}</span></span>
        <span>L: <span className="font-mono text-[#b3b3b3]">{coin ? `$${formatPrice(coin.low24h, precision)}` : '-'}</span></span>
      </div>

      <div className="w-[1px] h-[20px] bg-[#1f1f1f] flex-shrink-0" />

      <div className="flex items-center gap-[4px] text-[11px] text-[#888]">
        <span>Vol: <span className="font-mono text-[#b3b3b3]">${volDisplay}</span></span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          className={`clinic-btn clinic-btn-sm flex items-center gap-1 text-[11px] ${settingsOpen ? 'clinic-btn-active' : 'clinic-btn-secondary'}`}
          onClick={() => setSettingsOpen(o => !o)}
          title="View settings"
        >
          <Settings2 size={13} />
          <span>View</span>
        </button>
        {settingsOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} />
            <ChartSettingsPanel />
          </>
        )}
        {activeTool !== null && (
          <span className="text-[10px] text-[#ccc] font-mono bg-[#333] px-[6px] py-[2px] rounded-[3px] border border-[#444]">
            {activeTool === 'h-ray' ? 'Horiz. ray' : activeTool === 't-ray' ? 'Trend ray' : activeTool === 'alert' ? 'Price alert' : 'Segment'} — click on chart | Esc — cancel
          </span>
        )}
        <span className="text-[10px] text-[#666] font-mono">
          Shift + LMB / wheel — measure %
        </span>
      </div>
    </div>
  )
})

function ExpandedChart({ symbol, onBack, chartExchange }: { symbol: string; onBack: () => void; chartExchange: ChartExchange }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const adjustingRef = useRef(false)
  const pricePrecision = useCoinPrecision(symbol, chartExchange)
  const baseSettings = useChartSettings()
  const settingsRef = useRef(baseSettings)
  useEffect(() => {
    settingsRef.current = baseSettings
  })
  const exchange: Exchange | undefined = chartExchange
  const [selection, setSelection] = useState<RangeSelection | null>(null)
  const [chartVersion, setChartVersion] = useState(0)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const lastUpdateRef = useRef(0)
  const eventsRef = useRef<CandleEvents | null>(null)
  const watermarkRef = useRef<ReturnType<typeof applyWatermark>>(null)

  useEffect(() => {
    if (exchange) {
      eventsRef.current?.destroy()
      eventsRef.current = createCandleEvents({
        symbol, exchange, tf, tfSeconds: getTfSeconds(tf),
      })
    }
    return () => { eventsRef.current?.destroy() }
  }, [symbol, exchange, tf])

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return
    const s = settingsRef.current

    const base = buildChartOptions(s, { top: 0.05, bottom: 0.15 })
    const chart = createChart(containerRef.current, {
      ...base,
      handleScroll: true,
      // Mouse-drag inertia OFF (see MiniChart comment).
      kineticScroll: { touch: false, mouse: false },
    })

    const seriesOpts = candleSeriesOptions(s)
    const candleSeries = s.candlesType === 'line'
      ? chart.addSeries(LineSeries, seriesOpts as DeepPartial<LineSeriesOptions>)
      : s.candlesType === 'bars'
        ? chart.addSeries(BarSeries, seriesOpts as DeepPartial<BarSeriesOptions>)
        : chart.addSeries(CandlestickSeries, seriesOpts as DeepPartial<CandlestickSeriesOptions>)
    candleSeries.applyOptions({
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { ...volumeSeriesOptions(), priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: volumePaneTop(s.volumesHeight), bottom: 0 }, textColor: '#666666' })
    watermarkRef.current = applyWatermark(chart, s, symbol)

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries

    setChartVersion(v => v + 1)

    let prevW = containerRef.current.clientWidth
    let prevH = containerRef.current.clientHeight
    const ro = new ResizeObserver(() => {
      if (containerRef.current && !destroyedRef.current) {
        const w = containerRef.current.clientWidth
        const h = containerRef.current.clientHeight
        if (w < 10 || h < 10) return
        if (w === prevW && h === prevH) return
        prevW = w
        prevH = h
        chart.applyOptions({ width: w, height: h })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      destroyedRef.current = true
      ro.disconnect()
      watermarkRef.current?.detach()
      watermarkRef.current = null
      // See MiniChart's identical comment: stop any pending forming-candle
      // glide synchronously (Stage 2 item 3) before the series is disposed.
      stopFormingGlide(candleRef)
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [symbol, tf, pricePrecision, baseSettings.candlesType])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = useChartSettings.getState()
    chart.applyOptions({
      rightPriceScale: { mode: s.priceScaleMode === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal },
      grid: { vertLines: { visible: s.vertGrid }, horzLines: { visible: s.horzGrid } },
      timeScale: { timeVisible: timeVisibleFor(s.interval), secondsVisible: secondsVisibleFor(s.interval), barSpacing: s.barSpace, rightOffset: s.rightOffset },
    })
    chart.priceScale('').applyOptions({ scaleMargins: { top: volumePaneTop(s.volumesHeight), bottom: 0 } })
    if (s.watermark >= 0) {
      watermarkRef.current?.detach()
      watermarkRef.current = applyWatermark(chart, s, symbol)
    }
  }, [baseSettings.priceScaleMode, baseSettings.vertGrid, baseSettings.horzGrid, baseSettings.interval, baseSettings.barSpace, baseSettings.rightOffset, baseSettings.volumesHeight, baseSettings.watermark, baseSettings.watermarkSize, baseSettings.watermarkPlace, baseSettings.watermarkPattern, symbol])

  const [wsCount, setWsCount] = useState(getWsOpenCount)
  useEffect(() => {
    const un = wsOnType('open', () => setWsCount(getWsOpenCount()))
    return un
  }, [])

  const [recentVersion, setRecentVersion] = useState(0)
  const bumpRecentVersion = useCallback(() => setRecentVersion(v => v + 1), [])

  const { isInitialLoading, status, dataVersion } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, {
    limit: EXPANDED_CANDLE_LIMIT,
    initialLimit: GRID_CANDLE_LIMIT,
    fitOnOpen: true,
    wsEpoch: wsCount,
    recentVersion,
  }, lastUpdateRef, eventsRef, chartVersion)

  const {
    activeTool,
    setActiveTool,
    removeDrawing,
    clearAllDrawings,
    hasDrawings,
    deactivateTool,
    handleClick: drawingClickHandler,
    handleMouseDown: drawingMouseDownHandler,
    handleMouseMove: drawingMouseMoveHandler,
    handleMouseUp: drawingMouseUpHandler,
    pendingPoint,
    primitiveRef,
    isDraggingRef,
    shiftLogicalOffset,
    CLICK_THRESHOLD,
  } = useDrawings(symbol, tf, chartRef, candleRef, containerRef, candlesDataRef, chartVersion, isInitialLoading, dataVersion)

  useChartOverlays(candleRef, candlesDataRef, dataVersion, chartVersion, pricePrecision)
  useDensityOverlay(candleRef, chartVersion, symbol, pricePrecision)

  const focusPrice = useCoinListStore(s => s.expandedFocusPrice)
  const clearFocusPrice = useCoinListStore(s => s.clearExpandedFocusPrice)
  useEffect(() => {
    if (!focusPrice || !isFinite(focusPrice) || focusPrice <= 0) return
    // Wait until history painted — setVisibleRange is a no-op on an empty
    // series and would be overwritten by the fit afterwards.
    if (isInitialLoading || dataVersion === 0) return
    const chart = chartRef.current
    if (!chart) return
    try {
      // Center the price scale on the wall price: disable autoscale so the
      // range sticks, then set a ±1.5% window around the target.
      chart.priceScale('right').applyOptions({ autoScale: false })
      const span = focusPrice * 0.015
      chart.priceScale('right').setVisibleRange({ from: focusPrice - span, to: focusPrice + span })
    } catch { /* chart mid-teardown */ }
    clearFocusPrice()
  }, [focusPrice, isInitialLoading, dataVersion, clearFocusPrice])

  const isStale = useStaleDataDetection(lastUpdateRef)

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useCandlesRecent(symbol, exchange, tf, bumpRecentVersion)
  useLazyScroll(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, setIsLoadingMore, eventsRef, shiftLogicalOffset)

  useEffect(() => {
    // Deferred: the release handler finished the drag; clearing one frame
    // later keeps the tooltip from flickering during symbol/TF switches.
    const raf = requestAnimationFrame(() => setSelection(null))
    return () => cancelAnimationFrame(raf)
  }, [symbol, tf])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let dragging = false
    let startX = 0
    let startY = 0
    let mouseDownX = 0
    let mouseDownY = 0
    let restoreOpts: { handleScroll?: boolean; handleScale?: boolean } | null = null
    let restoreDrawingOpts: { handleScroll?: boolean; handleScale?: boolean } | null = null

    const computeSelection = (curX: number, curY: number): RangeSelection => {
      const chart = chartRef.current
      const series = candleRef.current
      const x1 = Math.min(startX, curX)
      const x2 = Math.max(startX, curX)
      let startPrice = 0
      let endPrice = 0
      let changePct = 0
      let durationSec = 0
      let valid = false

      if (chart && series) {
        const pStart = series.coordinateToPrice(startY) as number | null
        const pEnd = series.coordinateToPrice(curY) as number | null

        if (pStart !== null && pEnd !== null && isFinite(pStart) && isFinite(pEnd) && pStart > 0) {
          startPrice = pStart
          endPrice = pEnd
          changePct = ((endPrice - startPrice) / startPrice) * 100
          valid = true
        }

        const t1Raw = chart.timeScale().coordinateToTime(x1) as number | null
        const t2Raw = chart.timeScale().coordinateToTime(x2) as number | null
        const t1Num = (t1Raw == null || typeof t1Raw === 'number')
          ? t1Raw as number | null
          : null
        const t2Num = (t2Raw == null || typeof t2Raw === 'number')
          ? t2Raw as number | null
          : null

        if (t1Num !== null && t2Num !== null) {
          durationSec = Math.abs(t2Num - t1Num)
        }
      }

      // Tooltip anchor clamped to the container HERE (event context — refs
      // are legal in handlers); the render reads plain numbers only.
      const box = containerRef.current
      const boxW = box?.clientWidth ?? 9999
      const boxH = box?.clientHeight ?? 9999
      const tooltipLeft = Math.min(Math.max(curX + 10, 0), boxW - 180)
      const tooltipTop = Math.min(Math.max(curY + 10, 0), boxH - 70)

      return {
        startX,
        startY,
        endX: curX,
        endY: curY,
        startPrice,
        endPrice,
        changePct,
        durationSec,
        valid,
        tooltipLeft,
        tooltipTop,
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      mouseDownX = e.clientX - rect.left
      mouseDownY = e.clientY - rect.top

      if ((e.button === 0 && e.shiftKey) || e.button === 1) {
        startX = mouseDownX
        startY = mouseDownY
        dragging = true
        e.preventDefault()
        e.stopPropagation()
        const chart = chartRef.current
        if (chart) {
          restoreOpts = { handleScroll: true, handleScale: true }
          chart.applyOptions({ handleScroll: false, handleScale: false })
        }
        setSelection(computeSelection(startX, startY))
        return
      }

      if (e.button === 0 && activeTool !== null && !e.shiftKey) {
        const chart = chartRef.current
        if (chart) {
          restoreDrawingOpts = { handleScroll: true, handleScale: true }
          chart.applyOptions({ handleScroll: false, handleScale: false })
        }
      } else if (e.button === 0 && !e.shiftKey) {
        drawingMouseDownHandler(e)
        if (isDraggingRef.current) {
          const chart = chartRef.current
          if (chart) {
            restoreDrawingOpts = { handleScroll: true, handleScale: true }
            chart.applyOptions({ handleScroll: false, handleScale: false })
          }
        }
      }
    }

    let mmRaf: number | null = null
    let mmX = 0, mmY = 0
    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height))

      drawingMouseMoveHandler(e)

      if (!dragging) return
      mmX = curX
      mmY = curY
      if (mmRaf != null) return
      mmRaf = requestAnimationFrame(() => {
        mmRaf = null
        if (!dragging) return
        setSelection(computeSelection(mmX, mmY))
      })
    }

    const restoreDrawingScroll = () => {
      const chart = chartRef.current
      if (chart && restoreDrawingOpts) {
        chart.applyOptions(restoreDrawingOpts)
        restoreDrawingOpts = null
      }
    }

    const onMouseUp = (e: MouseEvent) => {
      if (dragging) {
        dragging = false
        if (mmRaf != null) { cancelAnimationFrame(mmRaf); mmRaf = null }
        const chart = chartRef.current
        if (chart && restoreOpts) {
          chart.applyOptions(restoreOpts)
        }
        restoreOpts = null
        setSelection(null)
        restoreDrawingScroll()
        return
      }

      const wasDragging = isDraggingRef.current

      if (wasDragging) {
        drawingMouseUpHandler(e)
        restoreDrawingScroll()
      }

      if (e.button === 0 && activeTool !== null && !wasDragging) {
        restoreDrawingScroll()
        const rect = container.getBoundingClientRect()
        const upX = e.clientX - rect.left
        const upY = e.clientY - rect.top
        const dx = Math.abs(upX - mouseDownX)
        const dy = Math.abs(upY - mouseDownY)
        if (dx < CLICK_THRESHOLD && dy < CLICK_THRESHOLD) {
          drawingClickHandler(e)
        }
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null)
        dragging = false
        if (mmRaf != null) { cancelAnimationFrame(mmRaf); mmRaf = null }
        const chart = chartRef.current
        if (chart && restoreOpts) {
          chart.applyOptions(restoreOpts)
        }
        restoreOpts = null
        restoreDrawingScroll()
        deactivateTool()
      }
    }

    const onAuxclick = (e: MouseEvent) => { if (e.button === 1) e.preventDefault() }

    container.addEventListener('mousedown', onMouseDown, true)
    container.addEventListener('auxclick', onAuxclick)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      container.removeEventListener('mousedown', onMouseDown, true)
      container.removeEventListener('auxclick', onAuxclick)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      dragging = false
      if (mmRaf != null) cancelAnimationFrame(mmRaf)
    }
  }, [symbol, tf, activeTool, drawingClickHandler, drawingMouseDownHandler, drawingMouseMoveHandler, drawingMouseUpHandler, deactivateTool, isDraggingRef, CLICK_THRESHOLD, removeDrawing])

  const precision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      const primitive = primitiveRef.current
      if (!primitive) return
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const hit = primitive.hitTest?.(x, y)
      if (hit) {
        removeDrawing(hit.externalId)
      }
    }
    container.addEventListener('contextmenu', onCtx)
    return () => container.removeEventListener('contextmenu', onCtx)
  }, [primitiveRef, removeDrawing])

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0e0e0e]">
      <ExpandedChartHeader symbol={symbol} onBack={onBack} activeTool={activeTool} chartExchange={chartExchange} />
      <div ref={containerRef} className="relative flex-1 min-h-0 [transform:translateZ(0)] [backface-visibility:hidden] [contain:paint]">
        {isInitialLoading && <ChartCornerSpinner />}
        {!isInitialLoading && status === 'retrying' && <ChartCornerSpinner />}
        {!isInitialLoading && isLoadingMore && (
          <div className="absolute top-[8px] left-[8px] z-30 pointer-events-none">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-[4px] bg-[#1a1a1a]/95 border border-[#2a2a2a] shadow-lg">
              <div className="w-[12px] h-[12px] border-2 border-[#555] border-t-[#ccc] rounded-full animate-spin" />
              <span className="text-[11px] text-[#aaa] font-medium">Loading history...</span>
            </div>
          </div>
        )}
        {isStale && <StaleDataOverlay visible={true} />}
        {status === 'empty' && <ChartMessageOverlay label="No data for this timeframe" />}
        {status === 'error' && <ChartMessageOverlay label="Error loading data. Try another timeframe." tone="error" />}

        <DrawingToolsPanel
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          clearAllDrawings={clearAllDrawings}
          hasDrawings={hasDrawings}
          pendingPoint={pendingPoint}
        />

        {selection && Math.abs(selection.endX - selection.startX) > 2 && (
          <div className="pointer-events-none absolute inset-0 z-30">
            <div
              className={`absolute border ${
                selection.valid && selection.changePct >= 0
                  ? 'border-[#26a65b]/70 bg-[#26a65b]/10'
                  : selection.valid
                    ? 'border-[#e74c3c]/70 bg-[#e74c3c]/10'
                    : 'border-[#f9b600]/70 bg-[#f9b600]/10'
              }`}
              style={{
                left: Math.min(selection.startX, selection.endX),
                top: Math.min(selection.startY, selection.endY),
                width: Math.abs(selection.endX - selection.startX),
                height: Math.max(2, Math.abs(selection.endY - selection.startY)),
              }}
            />
            <div
              className={`absolute px-[8px] py-[5px] rounded-[4px] text-[11px] font-mono bg-[#141414] border shadow-lg whitespace-nowrap ${
                !selection.valid
                  ? 'border-[#3a3a3a] text-[#888]'
                  : selection.changePct >= 0
                    ? 'border-[#26a65b] text-[#26a65b]'
                    : 'border-[#e74c3c] text-[#e74c3c]'
              }`}
              style={{
                left: selection.tooltipLeft,
                top: selection.tooltipTop,
              }}
            >
              {selection.valid ? (
                <>
                  <div className="text-[13px] font-bold">
                    {selection.changePct >= 0 ? '+' : ''}
                    {selection.changePct.toFixed(2)}%
                  </div>
                  <div className="text-[10px] text-[#888] mt-[2px]">
                    ${formatPrice(selection.startPrice, precision)} → ${formatPrice(selection.endPrice, precision)}
                  </div>
                  <div className="text-[10px] text-[#666]">
{formatDuration(selection.durationSec)}
                  </div>
                </>
              ) : (
                <span>Select a range</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const ChartGrid = memo(function ChartGrid() {
  const sortedCoins = useCoinListStore(s => s.sortedCoins)
  const pageIndex = useCoinListStore(s => s.pageIndex)
  // New array identity when sortedCoins reorders, but getOrFetchBulk serves
  // every symbol from the cache, so a reorder never triggers a network fetch.
  const topSymbols = useMemo(
    () => sortedCoins.slice(pageIndex * 9, pageIndex * 9 + 9).map(c => c.symbol),
    [sortedCoins, pageIndex],
  )
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const expandChart = useCoinListStore(s => s.expandChart)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const chartExchange = useCoinListStore(s => s.chartExchange)

  useInitialCandlesPush()

  // Parent layout effects run before the mini charts' passive history effects.
  // Register the one bulk request first so every child joins it instead of
  // opening nine individual GETs on a cold grid.
  useLayoutEffect(() => {
    if (topSymbols.length === 0) return
    getOrFetchBulk(topSymbols, tf, GRID_CANDLE_LIMIT, chartExchange).catch(() => {})
  }, [topSymbols, tf, chartExchange])

  if (expandedSymbol) {
    return <ExpandedChart symbol={expandedSymbol} onBack={() => expandChart(null)} chartExchange={chartExchange} />
  }

  return (
    <div className="flex-1 h-full flex flex-col bg-[#0a0a0a]">
      <div className="relative flex-1 min-h-0 p-[2px] grid grid-cols-3 grid-rows-3 gap-[2px] isolate">
        {topSymbols.map((symbol) => (
          <MiniChart
            key={`${chartExchange}:${symbol}`}
            symbol={symbol}
            chartExchange={chartExchange}
          />
        ))}
        {Array.from({ length: Math.max(0, 9 - topSymbols.length) }).map((_, idx) => (
          <div key={`placeholder-${idx}`} className="flex items-center justify-center bg-[#0e0e0e] border border-[#1f1f1f]" />
        ))}
      </div>
    </div>
  )
})
