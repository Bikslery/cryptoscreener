import { useEffect, useRef, memo, useState, useMemo } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore, setLivePrice, useAuthStore } from '../../store'
import { useSmoothedPriceRef } from '../../hooks/useSmoothedPrice'
import type { ChartExchange } from '../../store'
import { useShallow } from 'zustand/shallow'
import { wsOnChannel, wsOnType, wsSubscribe, wsUnsubscribe } from '../../services/ws'
import type { Timeframe, UnifiedCandle, Exchange, DrawingTool } from '../../types'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { ArrowLeft } from 'lucide-react'
import * as candleCache from '../../services/candle-cache'
import { getOrFetchHistory, getOrFetchOlder, getOrFetchBulk, GRID_CANDLE_LIMIT } from '../../services/candle-prefetch'
import { expandCompactCandles, type CompactCandle } from '../../services/candle-compact'
import { UP_COLOR, DOWN_COLOR, UP_COLOR_VOL, DOWN_COLOR_VOL, UP_BORDER, DOWN_BORDER } from './chart-colors'
import { createCandleLifecycle, type CandleLifecycle, type CandlePatch, type TradePayload, type GapBackfill } from '../../services/candle-lifecycle'
import { isFiniteOHLCV, validateCandle, normalizeCandle } from '../../services/candle-utils'
import { applyCandleUpdates } from '../../services/candle-merge'
import { beginFormingGlide, advanceFormingGlide, type FormingTarget, type FormingGlide } from '../../services/candle-anim'
import { registerGlider, unregisterGlider, glideDurationFor, type Glider } from '../../services/glide'
import { computeCursorAnchoredZoomRange } from '../../services/chart-zoom'
import { useDrawings } from './useDrawings'
import DrawingToolsPanel from './DrawingToolsPanel'


const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}
function getTfSeconds(tf: Timeframe): number { return TF_SECONDS[tf] || 60 }

/**
 * Zoom (ctrl/cmd+wheel or trackpad pinch) anchored at the cursor, so the bar
 * under the pointer stays in place — zooming in/out never shifts what the
 * user is looking at.
 *
 * Why this is needed: lightweight-charts' own wheel zoom is cursor-anchored,
 * but with `handleScale.mouseWheel` enabled every ctrl+wheel/pinch tick ALSO
 * hit the old custom handler, which called `applyOptions({ barSpacing })` —
 * that path anchors to the RIGHT EDGE of the data (bar-mode rightOffset stays
 * fixed), so the view jumped back toward the newest bars and the chart
 * visibly jittered when zooming out. The caller intercepts the event in the
 * capture phase and stopPropagation so LWC's native handler never fires.
 *
 * The new range is computed purely from the PRE-zoom visible range — nothing
 * is read after `applyOptions`/`setVisibleLogicalRange` (LWC applies options
 * asynchronously, and `coordinateToLogical` is integer-rounded, so both are
 * unreliable mid-zoom).
 */
function applyCursorAnchoredZoom(
  chart: IChartApi,
  container: HTMLElement,
  clientX: number,
  deltaY: number,
) {
  const ts = chart.timeScale()
  const vr = ts.getVisibleLogicalRange()
  if (!vr) return
  const width = ts.width()
  if (width <= 0) return
  const rect = container.getBoundingClientRect()
  const next = computeCursorAnchoredZoomRange(vr, width, clientX - rect.left, deltaY)
  if (!next) return
  ts.setVisibleLogicalRange(next)
}

function repaintSeries(
  chartRef: React.RefObject<IChartApi | null> | undefined,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  candles: UnifiedCandle[],
) {
  if (!candleRef.current || !volumeRef.current || candles.length === 0) return
  // A repaint paints exact data — any pending forming-candle glide must stop
  // so it can't overwrite the exact values on the next frame.
  getFormingAnimator(candleRef.current, () => candleRef.current, volumeRef.current, () => volumeRef.current).reset()
  const valid = candles.filter(validateCandle).map(normalizeCandle)
  if (valid.length === 0) return
  // Capture the view BEFORE setData — LWC recomputes the scale from the new
  // data, and restoring the same logical window keeps the viewport put.
  const ts = chartRef?.current?.timeScale()
  const prevLogical = ts ? ts.getVisibleLogicalRange() : null
  try {
    candleRef.current.setData(valid.map(c => ({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    })))
    volumeRef.current.setData(valid.map(c => ({
      time: c.time as Time, value: c.volume,
      color: c.close >= c.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
    })))
    if (ts && prevLogical) {
      ts.setVisibleLogicalRange(prevLogical)
    }
  } catch {}
}

/**
 * Smooth forming-candle renderer (scalpboard-style glide).
 *
 * The backing array stays authoritative and exact; this animator only
 * interpolates what gets PAINTED on the last (forming) bar. Each live update
 * (trade / bookTicker mid / non-final kline) sets a new target; a shared
 * rAF coordinator glides the displayed OHLC toward it with TIME-BASED easing
 * (easeOutCubic) and an ADAPTIVE duration — active pairs (updates every few
 * ms) converge almost instantly, quiet symbols glide long and smooth. Final
 * candles, history loads and repaints always paint exact values — the
 * animation never touches data.
 */
class FormingAnimator implements Glider {
  private displayed: FormingTarget | null = null
  private target: FormingTarget | null = null
  private glide: FormingGlide | null = null
  private lastTargetAt = 0
  private readonly series: ISeriesApi<'Candlestick'>
  private readonly getRef: () => ISeriesApi<'Candlestick'> | null
  private readonly volSeries: ISeriesApi<'Histogram'>
  private readonly getVolRef: () => ISeriesApi<'Histogram'> | null

  constructor(
    series: ISeriesApi<'Candlestick'>,
    getRef: () => ISeriesApi<'Candlestick'> | null,
    volSeries: ISeriesApi<'Histogram'>,
    getVolRef: () => ISeriesApi<'Histogram'> | null,
  ) {
    this.series = series
    this.getRef = getRef
    this.volSeries = volSeries
    this.getVolRef = getVolRef
  }

  get isAnimating(): boolean {
    return this.glide !== null
  }

  /** Route a live forming-candle update through the animator. Returns true when handled. */
  paint(c: UnifiedCandle): boolean {
    const t: FormingTarget = {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume,
    }
    if (!this.displayed || this.displayed.time !== t.time) {
      // New bar (or first seed after a repaint): snap exactly — the glide
      // must never stretch across period boundaries.
      this.glide = null
      unregisterGlider(this)
      this.target = t
      this.displayed = { ...t }
      this.paintSeries(this.displayed)
      return true
    }
    this.target = t
    // Adaptive duration from how long it's been since the last live update.
    const now = performance.now()
    const interval = this.lastTargetAt === 0 ? 0 : now - this.lastTargetAt
    this.lastTargetAt = now
    this.glide = beginFormingGlide({ ...this.displayed }, t, glideDurationFor(interval))
    registerGlider(this)
    return true
  }

  /** Advance one frame (driven by the shared rAF coordinator). */
  tick(dt: number): boolean {
    if (this.getRef() !== this.series || !this.target || !this.displayed || !this.glide) return false
    const { next, converged, glide } = advanceFormingGlide(this.glide, dt)
    this.glide = glide
    if (converged) {
      this.glide = null
      this.displayed = { ...this.target }
      this.paintSeries(this.displayed)
      return false
    }
    this.displayed = next
    this.paintSeries(next)
    return true
  }

  /** A final kline (or any repaint) must show exact values — stop the glide. */
  reset() {
    this.glide = null
    unregisterGlider(this)
    this.displayed = null
    this.target = null
  }

  private paintSeries(t: FormingTarget) {
    try {
      this.series.update({
        time: t.time as Time,
        open: t.open,
        high: t.high,
        low: t.low,
        close: t.close,
      })
    } catch {
      // Series is gone (chart removed / recreated) — stop cleanly.
      this.reset()
      return
    }
    // Volume glides with the same eased progress; the color follows the
    // TARGET direction (authoritative) so it never flickers mid-glide.
    const vol = this.getVolRef()
    if (!vol || vol !== this.volSeries) {
      this.reset()
      return
    }
    try {
      this.volSeries.update({
        time: t.time as Time,
        value: t.volume,
        color: t.close >= t.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
      })
    } catch {
      this.reset()
    }
  }
}

// One animator per candle series (chart instance). WeakMap → GC'd with the
// series; the loop self-stops when the ref no longer points at this series
// (unmount, or pricePrecision flip recreates the series).
const formingAnimators = new WeakMap<ISeriesApi<'Candlestick'>, FormingAnimator>()

function getFormingAnimator(
  series: ISeriesApi<'Candlestick'>,
  getRef: () => ISeriesApi<'Candlestick'> | null,
  volSeries: ISeriesApi<'Histogram'>,
  getVolRef: () => ISeriesApi<'Histogram'> | null,
): FormingAnimator {
  let a = formingAnimators.get(series)
  if (!a) {
    a = new FormingAnimator(series, getRef, volSeries, getVolRef)
    formingAnimators.set(series, a)
  }
  return a
}

function applyChartPatch(
  patch: CandlePatch,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candlesDataRef?: React.RefObject<UnifiedCandle[]>,
  chartRef?: React.RefObject<IChartApi | null>,
) {
  const arr = candlesDataRef?.current
  // Sync the backing array (sorted upsert) and detect out-of-order updates.
  // lightweight-charts' series.update() THROWS for any bar older than the
  // series' last bar, so a patch containing older candles (gap-backfill after
  // a WS skip during sharp action, delayed klines) must be painted with a
  // full setData repaint — otherwise the candle is silently dropped and the
  // hole in history stays open forever.
  const needsRepaint = arr ? applyCandleUpdates(arr, patch.candleUpdates) : false

  if (needsRepaint && arr) {
    repaintSeries(chartRef, candleRef, volumeRef, arr)
  } else {
    let didRepaint = false
    const series = candleRef.current
    const animator = series && volumeRef.current
      ? getFormingAnimator(series, () => candleRef.current, volumeRef.current, () => volumeRef.current)
      : null
    // When the animator handles the forming bar, its volume glides along —
    // skip that bar in the exact-volume loop below so it doesn't jump.
    let formingTime: number | null = null
    for (const raw of patch.candleUpdates) {
      const c = normalizeCandle(raw)
      if (!isFiniteOHLCV(c)) continue
      const arrLast = arr && arr.length > 0 ? arr[arr.length - 1] : null
      if (animator) {
        if (c.isFinal) {
          // Period closed — paint exact values, stop any pending glide.
          animator.reset()
        } else if (arrLast && c.time === arrLast.time) {
          // Live forming-candle update (trade / mid / non-final kline): the
          // body and volume GLIDE toward the new values instead of teleporting.
          formingTime = c.time
          animator.paint(c)
          continue
        }
      }
      try {
        candleRef.current?.update({
          time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
        })
      } catch {
        // The series rejected the update (e.g. useFormingCandle painted a bar
        // ahead of candlesDataRef, making this one "old"). Repaint everything
        // from the backing array so the candle is never lost.
        didRepaint = true
        if (arr) repaintSeries(chartRef, candleRef, volumeRef, arr)
        break
      }
    }
    if (!didRepaint) {
      for (const raw of patch.volumeUpdates) {
        const v = normalizeCandle(raw)
        if (!isFinite(v.volume)) continue
        if (formingTime !== null && v.time === formingTime) continue
        try {
          volumeRef.current?.update({
            time: v.time as Time, value: v.volume,
            color: v.close >= v.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
          })
        } catch {
          if (arr) repaintSeries(chartRef, candleRef, volumeRef, arr)
          break
        }
      }
    }
  }

  if (patch.livePrice != null) {
    setLivePrice(symbol, patch.livePrice)
  }
  if (patch.cacheWrites && exchange) {
    for (const c of patch.cacheWrites) {
      candleCache.updateCandle(exchange, symbol, tf, normalizeCandle(c))
    }
  }
  const lastCandle = patch.candleUpdates[patch.candleUpdates.length - 1]
  if (lastCandle && candleRef.current) {
    // applyOptions triggers a style recalc — with bookTicker-mid updates
    // arriving dozens of times per second, only touch it when the color
    // actually flips (up ↔ down), not on every tick.
    const color = lastCandle.close >= lastCandle.open ? UP_COLOR() : DOWN_COLOR()
    if (lastPriceLineColor.get(candleRef.current) !== color) {
      lastPriceLineColor.set(candleRef.current, color)
      candleRef.current.applyOptions({ priceLineColor: color })
    }
  }
}

// Per-series cache of the last applied price-line color (avoids a style recalc
// on every live tick — the color only flips when a bar closes up vs down).
const lastPriceLineColor = new WeakMap<object, string>()

/**
 * Self-healing consistency check (the "no silent holes" insurance).
 *
 * Every paint path keeps the backing array (candlesDataRef) authoritative and
 * syncs LWC incrementally — but a series can still drift silently (an update
 * LWC rejected, a canvas/series recreate mid-stream, a dropped frame). This
 * hook periodically compares the series' last bar with the array's last entry
 * and force-repaints (with visible-range preservation) when they diverge, so a
 * lost candle is restored automatically instead of leaving a permanent hole.
 */
const SERIES_SELF_HEAL_INTERVAL_MS = 2500

function useSeriesSelfHeal(
  chartRef: React.RefObject<IChartApi | null>,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
) {
  useEffect(() => {
    const timer = setInterval(() => {
      if (destroyedRef.current) return
      if (adjustingRef?.current) return
      const series = candleRef.current
      const volSeries = volumeRef.current
      const arr = candlesDataRef.current
      if (!series || !volSeries || !arr || arr.length === 0) return

      // During a forming-candle glide the series' last bar intentionally
      // differs from the array — skip the check until it converges.
      const anim = formingAnimators.get(series)
      if (anim?.isAnimating) return

      let lwcLast: { time: number; close: number; volume: number } | null = null
      try {
        const data = series.data()
        const last = data[data.length - 1] as { time: unknown; close: number } | undefined
        const volData = volSeries.data()
        const volLast = volData[volData.length - 1] as { value: number } | undefined
        if (last && volLast) {
          lwcLast = { time: last.time as number, close: last.close, volume: volLast.value }
        }
      } catch {
        return
      }

      const arrLast = arr[arr.length - 1]
      if (!arrLast) return

      const diverged = !lwcLast
        || lwcLast.time !== arrLast.time
        || Math.abs(lwcLast.close - arrLast.close) > 1e-12
        || Math.abs(lwcLast.volume - (arrLast.volume || 0)) > 1e-9

      if (diverged) {
        console.warn('[ChartGrid] Series drifted from backing array — self-heal repaint', {
          symbol: arrLast.symbol,
          lwc: lwcLast,
          arr: { time: arrLast.time, close: arrLast.close, volume: arrLast.volume },
        })
        repaintSeries(chartRef, candleRef, volumeRef, arr)
      }
    }, SERIES_SELF_HEAL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Fetch and apply candles for a detected period gap (WS stream skipped one or
 * more buckets, e.g. after a brief disconnect during sharp price action).
 *
 * Uses `getOrFetchOlder` with `before = toTime + tfSec` and then filters to
 * the exact [fromTime, toTime] window. Deduplicated per (symbol,tf,gap) via an
 * in-flight set so a burst of late klines/trades for the same gap fires only
 * one REST request. The merge uses lifecycle.applyOlderPage + applyChartPatch
 * so it reuses the same draw/cache path as everything else.
 *
 * Safe to call concurrently from useWsCandle and useWsTrade — the second call
 * for the same gap no-ops once one is in flight, and overlapping fetches for
 * adjacent gaps are merged by the dedup-by-time inside applyChartPatch.
 */
const backfillInflightKeys = new Set<string>()

function backfillGap(
  gap: GapBackfill,
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  lifecycleRef: React.RefObject<CandleLifecycle | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]> | undefined,
  chartRef?: React.RefObject<IChartApi | null>,
) {
  if (!exchange) return
  if (destroyedRef.current) return
  const key = `${exchange}:${symbol}:${tf}:${gap.fromTime}-${gap.toTime}`
  if (backfillInflightKeys.has(key)) return
  // Also collapse adjacent/nested gaps for the same series into one fetch
  // window — a tight burst of WS messages often produces near-duplicate gaps.
  const tfSec = getTfSeconds(tf)
  for (const existing of backfillInflightKeys) {
    const prefix = `${exchange}:${symbol}:${tf}:`
    if (!existing.startsWith(prefix)) continue
    const range = existing.slice(prefix.length).split('-')
    const exFrom = Number(range[0])
    const exTo = Number(range[1])
    if (gap.fromTime >= exFrom - tfSec && gap.fromTime <= exTo + tfSec) {
      // Overlaps or touches an in-flight gap — skip; that fetch will cover us.
      return
    }
  }

  backfillInflightKeys.add(key)
  const before = gap.toTime + tfSec
  const limit = Math.max(2, Math.round((gap.toTime - gap.fromTime) / tfSec) + 2)

  getOrFetchOlder(symbol, tf, before, limit, exchange)
    .then(candles => {
      if (destroyedRef.current) return
      const lc = lifecycleRef.current
      if (!lc) return
      const inWindow = candles.filter(c => c.time >= gap.fromTime && c.time <= gap.toTime)
      if (inWindow.length === 0) return
      // Apply through the lifecycle so tail state stays consistent, then paint.
      const patch = lc.applyOlderPage(inWindow)
      applyChartPatch(patch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef, chartRef)
    })
    .catch(() => {
      // Network/server error — the gap remains visible but we don't crash.
      // A subsequent kline for a later period will trigger another attempt.
    })
    .finally(() => {
      backfillInflightKeys.delete(key)
    })
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

function LiveIndicator({ isLive, lastUpdate, hasReceivedData }: { isLive: boolean; lastUpdate: number; hasReceivedData: boolean }) {
  const timeSinceUpdate = Date.now() - lastUpdate
  const showWarning = timeSinceUpdate > 3000

  const connecting = !hasReceivedData

  return (
    <div className="absolute top-[8px] right-[8px] z-30 pointer-events-none flex items-center gap-[6px] px-[8px] py-[4px] rounded-[4px] bg-[#141414]/95 border border-[#2a2a2a] shadow-lg">
      <div
        className={`w-[6px] h-[6px] rounded-full ${
          connecting
            ? 'bg-[#e8a838] connecting-indicator-pulse'
            : isLive && !showWarning
            ? 'bg-[#26a65b] live-indicator-pulse'
            : 'bg-[#666]'
        }`}
      />
      <span className={`text-[9px] font-bold tracking-wide ${
        connecting
          ? 'text-[#e8a838]'
          : isLive && !showWarning ? 'text-[#26a65b]' : 'text-[#666]'
      }`}>
        {connecting ? 'CONNECTING' : isLive && !showWarning ? 'LIVE' : 'PAUSED'}
      </span>
    </div>
  )
}

function StaleDataOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <div className="stale-data-overlay absolute inset-0 z-40 flex items-center justify-center pointer-events-none bg-[#0a0a0a]/60 backdrop-blur-[3px]">
      <div className="rounded-[6px] border border-[#e74c3c]/40 bg-[#1a1010]/95 px-4 py-3 text-[12px] font-medium shadow-[0_12px_30px_rgba(0,0,0,0.35)] flex items-center gap-3">
        <div className="w-[14px] h-[14px] border-2 border-[#e74c3c]/40 border-t-[#e74c3c] rounded-full animate-spin" />
        <span className="text-[#f0b0aa]">Переподключение к серверу...</span>
      </div>
    </div>
  )
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
        candleCache.storeBulk(expanded)
        return
      }
      candleCache.storeBulk(data as Record<string, UnifiedCandle[]>)
    })
    return () => { unsubReconnect(); unsubPush() }
  }, [])
}

function useFullHistory(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  options?: { limit?: number; visibleBars?: number; fitOnOpen?: boolean },
  lastUpdateRef?: React.RefObject<number>,
  lifecycleRef?: React.RefObject<CandleLifecycle | null>,
  chartVersion?: number,
): { isInitialLoading: boolean; status: 'loading' | 'ready' | 'empty' | 'error'; dataVersion: number } {
  const limit = options?.limit ?? 1000
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [dataVersion, setDataVersion] = useState(0)

  // Track the last painted (exchange,symbol,tf) key so a slow re-load of the
  // SAME chart preserves the user's visible range instead of snapping back to
  // the right edge (the "teleport" when the chart hadn't finished loading).
  // New keys (symbol change / TF switch) still snap to the latest bars.
  const lastPaintedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!exchange) return
    const cancelled = { value: false }
    setIsInitialLoading(true)
    setStatus('loading')

    const renderCandles = (candles: UnifiedCandle[]) => {
      if (destroyedRef.current || !candleRef.current || !volumeRef.current) {
        // Nothing was painted — release reconciliation so realtime events that
        // arrived during the fetch don't stay stuck in the buffer forever
        // (which would freeze the forming candle).
        lifecycleRef?.current?.setBuffered(false)
        return
      }
      const prevData = candlesDataRef.current
      candlesDataRef.current = candles
      // Filter out invalid candles before rendering
      const validCandles = candles.filter(validateCandle).map(normalizeCandle)
      const candleData = validCandles.map(c => ({
        time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
      }))
      const volumeData = validCandles.map(c => ({
        time: c.time as Time, value: c.volume,
        color: c.close >= c.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
      }))
      const key = `${exchange}:${symbol}:${tf}`
      const sameKey = lastPaintedKeyRef.current === key
      try {
        const ts = chartRef.current?.timeScale()
        // Capture BEFORE setData — setData resets the scale.
        const prevLogical = sameKey && prevData.length > 0 ? ts?.getVisibleLogicalRange() ?? null : null
        // Exact data replaces everything — a pending forming-candle glide
        // must not paint stale interpolated values onto the new series.
        getFormingAnimator(candleRef.current, () => candleRef.current, volumeRef.current, () => volumeRef.current).reset()
        candleRef.current.setData(candleData)
        volumeRef.current.setData(volumeData)
        if (ts && candleData.length > 0) {
          if (prevLogical) {
            // Re-load of the same chart: keep the user exactly where they were.
            // Restore by LOGICAL range, not by time — LWC's timeToIndex clamps
            // times beyond the last bar to the last index, so a time-restore
            // snapped the right edge onto the last candle whenever the view
            // extended past it (e.g. default rightOffset or zoomed-out view).
            ts.setVisibleLogicalRange(prevLogical)
          } else if (options?.fitOnOpen) {
            // Expanded chart: open maximally zoomed out — the whole loaded
            // history fits on screen. The user can zoom in from there.
            ts.fitContent()
          } else {
            const lastBar = candleData.length - 1
            // Initial scale when opening a chart with no saved view: how many
            // bars fit on screen. Mini charts default to 150; the expanded
            // chart uses the user's setting (default 450) via options.visibleBars.
            const rawVisibleBars = options?.visibleBars ?? 150
            const visibleBars = Math.min(Math.max(rawVisibleBars, 20), 2000)
            ts.setVisibleLogicalRange({ from: lastBar - visibleBars, to: lastBar + 5 })
          }
        }
      } catch {}
      lastPaintedKeyRef.current = key
      // Bump dataVersion so the drawing primitive re-syncs (logical indexes
      // shift when the underlying candle set is replaced, e.g. TF switch).
      setDataVersion(v => v + 1)
      if (lifecycleRef) {
        // Reconcile (scalpboard/cryptoscreener pattern): history is applied
        // first, then buffered realtime events that arrived DURING the fetch
        // are replayed on top — live updates are never lost or double-painted.
        if (validCandles.length > 0) {
          lifecycleRef.current?.applyHistory(validCandles)
        }
        const flushPatch = lifecycleRef.current?.setBuffered(false)
        if (flushPatch && flushPatch.candleUpdates.length > 0) {
          applyChartPatch(flushPatch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef, chartRef)
        }
      }
    }

    const run = async () => {
      // Begin reconciliation: buffer realtime kline/trade events while the
      // history loads so they aren't painted onto a partial array and then
      // wiped by setData below (the flicker when loading history). renderCandles
      // ends the buffering and replays the events on the loaded history.
      lifecycleRef?.current?.setBuffered(true)
      // Fast path: check client cache
      const cached = candleCache.getCandles(exchange, symbol, tf)
      if (cached && cached.length > 0) {
        if (!cancelled.value && !destroyedRef.current) {
          renderCandles(cached)
          setIsInitialLoading(false)
          setStatus('ready')
          // Update lastUpdateRef after successful data load
          if (lastUpdateRef) {
            lastUpdateRef.current = Date.now()
          }
        }
        return
      }

      // Fallback: individual fetch (server does seamless stitching)
      try {
        const fetched = await getOrFetchHistory(symbol, tf, limit, exchange)
        if (cancelled.value || destroyedRef.current) {
          // This run lost the race to a newer (symbol/exchange/tf) effect;
          // release reconciliation so live events are never stranded.
          lifecycleRef?.current?.setBuffered(false)
          return
        }
        if (fetched.length > 0) {
          renderCandles(fetched)
          setIsInitialLoading(false)
          setStatus('ready')
          // Update lastUpdateRef after successful data load
          if (lastUpdateRef) {
            lastUpdateRef.current = Date.now()
            console.log('[useFullHistory] Initial load from server', { symbol, tf, candles: fetched.length })
          }
        } else {
          // Empty history (server had nothing, or the fetch failed and
          // getOrFetchHistory swallowed it): release the buffer so the forming
          // candle can still be painted from live kline/trade events.
          lifecycleRef?.current?.setBuffered(false)
          setIsInitialLoading(false)
          setStatus('empty')
        }
      } catch {
        // Fetch failed — release reconciliation (the chart is empty/errored
        // here; buffered events are discarded and the next load resyncs).
        lifecycleRef?.current?.setBuffered(false)
        setIsInitialLoading(false)
        setStatus('error')
      }
    }

    run()
    return () => { cancelled.value = true }
    // `chartVersion` re-paints history when the canvas/series is recreated
    // (e.g. pricePrecision flips): the new chart starts empty and would only
    // show the live forming candle until the next symbol/TF change, because
    // symbol/exchange/tf haven't changed. Without this, a recreated chart
    // showed "just the last candle" until a kline arrived.
  }, [symbol, exchange, tf, chartVersion])

  return { isInitialLoading, status, dataVersion }
}

function useLazyScroll(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  isInitialLoading: boolean,
  adjustingRef: React.RefObject<boolean>,
  setIsLoadingMore?: (loading: boolean) => void,
  lifecycleRef?: React.RefObject<CandleLifecycle | null>,
  onLogicalShift?: (added: number) => void,
  ) {
  const inflightRef = useRef(false)
  const reachedStartRef = useRef(false)
  const symbolRef = useRef(symbol)
  const exchangeRef = useRef(exchange)
  const tfRef = useRef(tf)
  const emptyCountRef = useRef(0)
  const prefetchInflightRef = useRef(false)

  useEffect(() => {
    symbolRef.current = symbol
    exchangeRef.current = exchange
    tfRef.current = tf
    reachedStartRef.current = false
    inflightRef.current = false
    adjustingRef.current = false
    emptyCountRef.current = 0
    prefetchInflightRef.current = false
  }, [symbol, exchange, tf])

  // Throttle instead of debounce: first call fires immediately (no delay),
  // subsequent calls within 100ms are suppressed but the last one is replayed.
  // This prevents both "empty space on fast scroll" (debounce too late)
  // and "dozens of redundant checks" (no throttle at all).
  const onRange = useMemo(() => {
    let lastCallTime = 0
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    let pendingRange: { from: number; to: number } | null = null

    const fire = (range: { from: number; to: number } | null) => {
      if (!range || adjustingRef.current || inflightRef.current || reachedStartRef.current) return

      const visibleBars = range.to - range.from

      // --- PREFETCH LAYER ---
      // When user is approaching the edge (within 1.5× visible range),
      // start prefetching into the cache BEFORE they actually need it.
      // Fire-and-forget — warms the cache; the LOAD layer then paints from
      // the cache without a network round-trip in the critical path.
      const prefetchThreshold = Math.max(200, visibleBars * 1.5)
      if (range.from < prefetchThreshold && !prefetchInflightRef.current) {
        const curSymbol = symbolRef.current
        const curExchange = exchangeRef.current
        const curTf = tfRef.current
          if (curExchange) {
            const cached = candleCache.getCandles(curExchange, curSymbol, curTf)
            if (cached && cached.length > 0) {
              prefetchInflightRef.current = true
              const before = cached[0].time
              getOrFetchOlder(curSymbol, curTf, before, 1000, curExchange)
                .then(older => {
                  const fresh = older.filter(c => c.time < before)
                  if (fresh.length > 0) {
                    candleCache.prependCandles(curExchange, curSymbol, curTf, fresh)
                  }
                })
                .catch(() => {})
                .finally(() => { prefetchInflightRef.current = false })
            }
          }
      }

      // --- LOAD LAYER ---
      // Trigger actual chart data load when closer to the edge
      const loadThreshold = Math.max(150, visibleBars * 0.8)

      if (range.from > loadThreshold) return

      const curSymbol = symbolRef.current
      const curExchange = exchangeRef.current
      const curTf = tfRef.current

      if (!curExchange) {
        inflightRef.current = false
        setIsLoadingMore?.(false)
        return
      }

      inflightRef.current = true
      setIsLoadingMore?.(true)

      // Reconcile: buffer realtime kline/trade events for the WHOLE fetch
      // window (not just the paint). paint() ends the buffering and replays
      // them on the merged history; the empty/catch paths below release it
      // too, so live updates can never stay stuck in the buffer.
      lifecycleRef?.current?.setBuffered(true)

      const cached = candleCache.getCandles(curExchange, curSymbol, curTf)
      if (!cached || cached.length === 0) {
        inflightRef.current = false
        setIsLoadingMore?.(false)
        // Nothing to paint — drop the buffer (next live event self-heals).
        lifecycleRef?.current?.setBuffered(false)
        return
      }

      // Apply merged data to the chart, preserving the visible range by TIME
      // (times are stable across a prepend; logical indexes shift).
      const paint = (merged: UnifiedCandle[]) => {
        const chart = chartRef.current
        const ts = chart?.timeScale()
        if (!chart || !ts || destroyedRef.current) return

        const prevLogical = ts.getVisibleLogicalRange()
        const prevLen = candlesDataRef.current.length
        candlesDataRef.current = merged
        const added = merged.length - prevLen

        if (added <= 0) return

        adjustingRef.current = true
        lifecycleRef?.current?.setBuffered(true)

        try {
          const normalized = merged.map(normalizeCandle)
          const candleData = normalized.map(c => ({
            time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
          }))
          const volumeData = normalized.map(c => ({
            time: c.time as Time, value: c.volume,
            color: c.close >= c.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
          }))
          onLogicalShift?.(added)

          const seriesAfterLoad = candleRef.current
          if (seriesAfterLoad && volumeRef.current) getFormingAnimator(seriesAfterLoad, () => candleRef.current, volumeRef.current, () => volumeRef.current).reset()
          candleRef.current?.setData(candleData)
          volumeRef.current?.setData(volumeData)

          lifecycleRef?.current?.applyHistory(merged)
          const flushPatch = lifecycleRef?.current?.setBuffered(false)
          if (flushPatch && flushPatch.candleUpdates.length > 0) {
            applyChartPatch(flushPatch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef, chartRef)
          }

          // Restore by LOGICAL range shifted by `added` — prepending bars
          // shifts every old logical index by `added`, so [from+added, to+added]
          // puts back the exact same bars at the same pixels, preserving the
          // user's zoom and any empty space on the right. (Restoring by TIME
          // snapped the right edge onto the last candle whenever the view
          // extended past it: LWC's timeToIndex clamps beyond-the-last-bar
          // times to the last index.)
          if (prevLogical) {
            ts.setVisibleLogicalRange({ from: prevLogical.from + added, to: prevLogical.to + added })
          }
        } catch (err) {
          console.error('[ChartGrid] setData failed during lazy scroll', { symbol, tf, error: err })
        } finally {
          adjustingRef.current = false
        }
      }

      const before = cached[0].time

      // Fast path: the prefetch layer already filled the cache past the current
      // left edge — paint from cache with no network round-trip at all.
      const paintedFirst = candlesDataRef.current[0]?.time
      if (paintedFirst != null && cached[0].time < paintedFirst && cached.length > candlesDataRef.current.length) {
        paint(cached)
        inflightRef.current = false
        setIsLoadingMore?.(false)
        return
      }

      getOrFetchOlder(curSymbol, curTf, before, 1000, curExchange)
        .then(older => {
          if (destroyedRef.current) {
            inflightRef.current = false
            setIsLoadingMore?.(false)
            return
          }

          // Filter out candles we already have (time >= before)
          const newCandles = older.filter(c => c.time < before)
          if (newCandles.length === 0) {
            emptyCountRef.current++
            if (emptyCountRef.current >= 3) {
              reachedStartRef.current = true
            }
            inflightRef.current = false
            setIsLoadingMore?.(false)
            // End reconciliation: replay any live events buffered during the
            // fetch onto the current chart.
            const flush = lifecycleRef?.current?.setBuffered(false)
            if (flush && flush.candleUpdates.length > 0) {
              applyChartPatch(flush, candleRef, volumeRef, curSymbol, curExchange, curTf, candlesDataRef, chartRef)
            }
            return
          }

          // Got new data — reset empty counter
          emptyCountRef.current = 0

          candleCache.prependCandles(curExchange, curSymbol, curTf, newCandles)
          const merged = candleCache.getCandles(curExchange, curSymbol, curTf)
          if (!merged || merged.length === 0) {
            inflightRef.current = false
            setIsLoadingMore?.(false)
            return
          }

          paint(merged)
          inflightRef.current = false
          setIsLoadingMore?.(false)
        })
        .catch((err: Error & { isNetworkError?: boolean }) => {
          if (!err?.isNetworkError) {
            emptyCountRef.current++
            if (emptyCountRef.current >= 3) {
              reachedStartRef.current = true
            }
          }
          inflightRef.current = false
          setIsLoadingMore?.(false)
          // End reconciliation: replay buffered live events onto the chart.
          const flush = lifecycleRef?.current?.setBuffered(false)
          if (flush && flush.candleUpdates.length > 0) {
            applyChartPatch(flush, candleRef, volumeRef, curSymbol, curExchange, curTf, candlesDataRef, chartRef)
          }
        })
    }

    const throttled = (range: { from: number; to: number } | null) => {
      if (!range) { fire(null); return }
      const now = Date.now()
      if (now - lastCallTime >= 100) {
        lastCallTime = now
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
        fire(range)
      } else {
        pendingRange = range
        if (!pendingTimer) {
          pendingTimer = setTimeout(() => {
            pendingTimer = null
            lastCallTime = Date.now()
            fire(pendingRange)
            pendingRange = null
          }, 100 - (now - lastCallTime))
        }
      }
    }

    return throttled
  }, [])

  useEffect(() => {
    if (isInitialLoading) return
    const chart = chartRef.current
    if (!chart) return
    const ts = chart.timeScale()

    ts.subscribeVisibleLogicalRangeChange(onRange)
    return () => { ts.unsubscribeVisibleLogicalRangeChange(onRange) }
  }, [symbol, tf, isInitialLoading, onRange])
  }

function useLiveIndicator(
  lastUpdateRef: React.RefObject<number>
): { isLive: boolean; lastUpdate: number; hasReceivedData: boolean } {
  const [state, setState] = useState({ isLive: true, lastUpdate: Date.now(), hasReceivedData: false })
  const mountTimeRef = useRef(Date.now())

  useEffect(() => {
    mountTimeRef.current = Date.now()
    const interval = setInterval(() => {
      const now = Date.now()
      const timeSinceUpdate = now - lastUpdateRef.current
      const hasReceivedData = lastUpdateRef.current > mountTimeRef.current
      setState({
        isLive: timeSinceUpdate < 3000,
        lastUpdate: lastUpdateRef.current,
        hasReceivedData
      })
    }, 500)

    return () => clearInterval(interval)
  }, [])

  return state
}

function useStaleDataDetection(
  lastUpdateRef: React.RefObject<number>,
  threshold = 30000 // Увеличено до 30 секунд для низколиквидных пар
): boolean {
  const [isStale, setIsStale] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastUpdateRef.current
      const shouldBeStale = elapsed > threshold

      // Debug logging
      if (shouldBeStale !== isStale) {
        console.log('[StaleDetection]', {
          elapsed: Math.round(elapsed / 1000) + 's',
          threshold: Math.round(threshold / 1000) + 's',
          isStale: shouldBeStale,
          lastUpdate: new Date(lastUpdateRef.current).toLocaleTimeString()
        })
      }

      setIsStale(shouldBeStale)
    }, 1000)

    return () => clearInterval(interval)
  }, [threshold])

  return isStale
}

function useWsCandle(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  lifecycleRef: React.RefObject<CandleLifecycle | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef?: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
  lastUpdateRef?: React.RefObject<number>,
  chartRef?: React.RefObject<IChartApi | null>,
) {
  useEffect(() => {
    if (!exchange) return
    const channel = `candle:${exchange}:${symbol}:${tf}`
    const unsub = wsOnChannel(channel, (msg) => {
      if (destroyedRef.current) return

      const c = msg.data as UnifiedCandle
      if (!c) return

      if (lastUpdateRef) {
        lastUpdateRef.current = Date.now()
      }

      if (!isFiniteOHLCV(c)) return

      const lc = lifecycleRef.current
      if (!lc) return

      const patch = lc.applyKline(c)
      if (adjustingRef?.current) return

      applyChartPatch(patch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef, chartRef)
      if (patch.gapBackfill) {
        backfillGap(patch.gapBackfill, symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, chartRef)
      }
    })
    wsSubscribe(channel)
    return () => {
      unsub()
      wsUnsubscribe(channel)
    }
  }, [symbol, exchange, tf])
}

function useWsTrade(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  lifecycleRef: React.RefObject<CandleLifecycle | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef?: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
  lastUpdateRef?: React.RefObject<number>,
  chartRef?: React.RefObject<IChartApi | null>,
) {
  useEffect(() => {
    if (!exchange) return
    const tradeType = `trade:${exchange}:${symbol}`

    const unsub = wsOnType(tradeType, (msg) => {
      if (destroyedRef.current) return

      const trade = msg.data as any
      if (!trade?.price) return

      if (lastUpdateRef) {
        lastUpdateRef.current = Date.now()
      }

      const price = typeof trade.price === 'number' ? trade.price : parseFloat(trade.price)
      if (!isFinite(price)) return

      const qty = typeof trade.volume === 'number' && isFinite(trade.volume) && trade.volume >= 0
        ? trade.volume
        : 0

      const lc = lifecycleRef.current
      if (!lc) return

      const tradeTime = typeof trade.time === 'number' && isFinite(trade.time)
        ? trade.time
        : Math.floor(Date.now() / 1000)

      const payload: TradePayload = {
        symbol,
        exchange: exchange!,
        price,
        qty,
        time: tradeTime,
      }

      const patch = lc.applyTrade(payload)
      if (adjustingRef?.current) return

      applyChartPatch(patch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef, chartRef)
      if (patch.gapBackfill) {
        backfillGap(patch.gapBackfill, symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, chartRef)
      }
    })
    wsSubscribe(tradeType)

    // Fast-lane price: the server broadcasts bookTicker mid changes for this
    // symbol immediately (no 40ms batch) — header price moves on every
    // top-of-book change, which is what makes a chart feel truly "live".
    // Unsubscribed automatically when the chart closes.
    //
    // Exchange filter: the channel is keyed by symbol only, and mid comes from
    // bookTicker (binance-futures / bybit-futures). A spot chart must not be
    // driven by a futures mid (the two markets decohere during sharp moves) —
    // only the matching exchange's mid reaches this chart's candle and header.
    const priceChannel = `price:${symbol}`
    const unsubPrice = wsOnChannel(priceChannel, (msg) => {
      if (destroyedRef.current) return
      const d = msg.data as { symbol: string; exchange?: string; price: number } | undefined
      if (!d || typeof d.price !== 'number' || !isFinite(d.price) || d.price <= 0) return
      if (exchange && d.exchange && d.exchange !== exchange) return
      setLivePrice(symbol, d.price)
      // Mid drives the forming candle between trades — continuous, scalpboard-
      // style motion. Volume untouched; the next trade/kline corrects drift.
      const lc = lifecycleRef.current
      if (!lc || adjustingRef?.current) return
      const patch = lc.applyMid(d.price)
      if (patch.candleUpdates.length > 0) {
        applyChartPatch(patch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef, chartRef)
      }
    })
    wsSubscribe(priceChannel)

    return () => {
      unsub()
      wsUnsubscribe(tradeType)
      unsubPrice()
      wsUnsubscribe(priceChannel)
    }
  }, [symbol, exchange, tf])
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
    }
  }))

  const isUp = coin ? coin.change24h >= 0 : true
  const badge = exchangeBadge(chartExchange)
  const vol = coin ? formatCompact(coin.quoteVolume24h) : '-'

  return (
    <div className="relative z-20 flex items-center justify-between px-[6px] py-[3px] border-b border-[#1f1f1f] flex-shrink-0 gap-2 bg-[#141414]">
      <div className="flex items-center gap-[5px] min-w-0">
        <span className="text-[9px] font-bold leading-none text-[#b3b3b3]">
          {badge}
        </span>
        <span className="font-bold text-[11px] text-[#e0e0e0] truncate" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {extractBaseAsset(symbol)}
        </span>
      </div>
      <div className="flex items-center gap-[6px] flex-shrink-0">
        {coin && (
          <>
            <span className={`font-mono font-bold text-[10px] ${isUp ? 'text-[#26a65b]' : 'text-[#e74c3c]'}`}>
              {isUp ? '+' : ''}{coin.change24h.toFixed(1)}%
            </span>
            <span className="font-mono text-[10px] text-[#888]">{coin.natr5m ? coin.natr5m.toFixed(1) : '-'}</span>
            <span className="font-mono text-[10px] text-[#888]">{coin.range1m ? coin.range1m.toFixed(1) : '-'}</span>
            <span className="font-mono text-[10px] text-[#888]">{vol}</span>
          </>
        )}
      </div>
    </div>
  )
})

const MiniChart = memo(function MiniChart({
  symbol, chartExchange,
}: { symbol: string; chartExchange: ChartExchange }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const exchange: Exchange | undefined = chartExchange
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const lastUpdateRef = useRef<number>(Date.now())
  const [chartVersion, setChartVersion] = useState(0)

  const lifecycleRef = useRef<CandleLifecycle | null>(null)

  useEffect(() => {
    if (exchange) {
      lifecycleRef.current?.destroy()
      lifecycleRef.current = createCandleLifecycle({
        symbol, exchange, tf, tfSeconds: getTfSeconds(tf),
      })
    }
    return () => { lifecycleRef.current?.destroy() }
  }, [symbol, exchange, tf])

  const liveIndicator = useLiveIndicator(lastUpdateRef)
  const isStale = useStaleDataDetection(lastUpdateRef)

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0e0e0e' }, textColor: '#666666', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { visible: true, color: '#4d4d4d' }, horzLine: { visible: true, color: '#4d4d4d' } },
      rightPriceScale: { borderColor: '#1f1f1f', scaleMargins: { top: 0.1, bottom: 0.25 }, textColor: '#666666' },
      timeScale: { borderColor: '#1f1f1f', timeVisible: true, visible: true, barSpacing: 6, rightOffset: 12, fixLeftEdge: false, fixRightEdge: false },
      handleScroll: true,
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        pinch: true,
        mouseWheel: true,
      },
      kineticScroll: { touch: false, mouse: false },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR(), downColor: DOWN_COLOR(),
      borderUpColor: UP_BORDER(), borderDownColor: DOWN_BORDER(),
      wickUpColor: UP_COLOR(), wickDownColor: DOWN_COLOR(),
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor: UP_COLOR(),
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', priceLineVisible: false, lastValueVisible: false })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, textColor: '#666666' })

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

    const onWheel = (e: WheelEvent) => {
      // Capture phase: run BEFORE lightweight-charts' own wheel listener on
      // the canvas and stopPropagation, so the native zoom (which would zoom
      // a second time, anchored elsewhere) never fires.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        if (containerRef.current) {
          applyCursorAnchoredZoom(chart, containerRef.current, e.clientX, e.deltaY)
        }
      }
    }
    containerRef.current.addEventListener('wheel', onWheel, { passive: false, capture: true })

    return () => {
      destroyedRef.current = true
      containerRef.current?.removeEventListener('wheel', onWheel, { capture: true })
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
    // NB: `tf` is deliberately NOT a dependency — a timeframe switch only needs
    // new data (useFullHistory handles setData + visible range), not a full
    // chart destroy/recreate. This makes TF switching near-instant on warm cache.
  }, [symbol, pricePrecision])

  const { isInitialLoading, status, dataVersion } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, { limit: GRID_CANDLE_LIMIT }, lastUpdateRef, lifecycleRef, chartVersion)

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

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef, chartRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef, chartRef)
  useLazyScroll(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, undefined, lifecycleRef, shiftLogicalOffset)
  useSeriesSelfHeal(chartRef, candleRef, volumeRef, destroyedRef, candlesDataRef, adjustingRef)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let mouseDownX = 0
    let mouseDownY = 0
    let restoreOpts: { handleScroll?: boolean; handleScale?: boolean } | null = null

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

    const onMouseDown = (e: MouseEvent) => {
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
    }

    const onMouseUp = (e: MouseEvent) => {
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
    return () => container.removeEventListener('contextmenu', onCtx)
  }, [primitiveRef, removeDrawing])

  return (
  <div className="relative flex flex-col h-full bg-[#0e0e0e] border border-[#1f1f1f] overflow-hidden rounded-[3px]">
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 select-none">
      <span className="text-[48px] font-bold text-white/[0.04] tracking-tighter uppercase" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
      {!isInitialLoading && <LiveIndicator isLive={liveIndicator.isLive} lastUpdate={liveIndicator.lastUpdate} hasReceivedData={liveIndicator.hasReceivedData} />}
      {isStale && <StaleDataOverlay visible={true} />}
    </div>
    {isInitialLoading && (
      <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
        <div className="w-[18px] h-[18px] border-2 border-[#333] border-t-[#999] rounded-full animate-spin" />
      </div>
    )}
    {status === 'empty' && <ChartMessageOverlay label="Нет данных для таймфрейма" />}
    {status === 'error' && <ChartMessageOverlay label="Ошибка загрузки данных" tone="error" />}
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

const ExpandedChartHeader = memo(function ExpandedChartHeader({ symbol, onBack, activeTool, chartExchange }: { symbol: string; onBack: () => void; activeTool: DrawingTool | null; chartExchange: ChartExchange }) {
  const coin = useCoinListStore(useShallow(s => {
    const c = s.coinMap.get(symbol)
    if (!c) return null
    return {
      exchange: c.exchange,
      change24h: c.change24h,
      price: c.price,
      quoteVolume24h: c.quoteVolume24h,
      pricePrecision: c.pricePrecision,
      high24h: c.high24h,
      low24h: c.low24h,
    }
  }))
  // Smoothed price display: glides toward the live value straight in the DOM
  // (no React re-render per frame — the shared rAF coordinator writes
  // textContent into the span). Presentation only — chart/store data stays
  // exact; fast markets converge within a few frames.
  const priceRef = useSmoothedPriceRef(symbol, coin?.pricePrecision ?? 2, coin?.price, '$')
  const isUp = coin ? coin.change24h >= 0 : true
  const badge = exchangeBadge(chartExchange)
  const precision = coin?.pricePrecision ?? 2
  const volDisplay = coin ? formatCompact(coin.quoteVolume24h) : '-'

  return (
    <div className="flex items-center gap-3 px-3 py-[6px] bg-[#141414] border-b border-[#1f1f1f] flex-shrink-0">
      <button
        className="clinic-btn clinic-btn-sm flex items-center justify-center w-[28px] h-[28px] p-0"
        onClick={onBack}
        title="Назад к сетке"
      >
        <ArrowLeft size={15} />
      </button>

      <div className="flex items-center gap-[8px] min-w-0">
        <span className="text-[10px] font-bold leading-none text-[#b3b3b3]">
          {badge}
        </span>
        <span className="font-bold text-[14px] text-[#f0f0f0] tracking-tight" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
        {activeTool !== null && (
          <span className="text-[10px] text-[#ccc] font-mono bg-[#333] px-[6px] py-[2px] rounded-[3px] border border-[#444]">
            {activeTool === 'h-ray' ? 'Гориз. луч' : activeTool === 't-ray' ? 'Тренд. луч' : activeTool === 'alert' ? 'Ценовой алерт' : 'Отрезок'} — клик на графике | Esc — отмена
          </span>
        )}
        <span className="text-[10px] text-[#666] font-mono">
          Shift + ЛКМ / Колёсико — измерить %
        </span>
      </div>
    </div>
  )
})

function ExpandedChart({ symbol, onBack, chartExchange }: { symbol: string; onBack: () => void; chartExchange: ChartExchange }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const adjustingRef = useRef(false)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const exchange: Exchange | undefined = chartExchange
  const [selection, setSelection] = useState<RangeSelection | null>(null)
  const [chartVersion, setChartVersion] = useState(0)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const lastUpdateRef = useRef<number>(Date.now())
  // Initial zoom when opening: by default the expanded chart opens maximally
  // zoomed out (fitContent). If the user set a custom value in profile
  // (chartVisibleBars), that explicit choice wins over the default.
  const chartVisibleBars = useAuthStore(s => s.settings?.chartVisibleBars)
  const lifecycleRef = useRef<CandleLifecycle | null>(null)

  useEffect(() => {
    if (exchange) {
      lifecycleRef.current?.destroy()
      lifecycleRef.current = createCandleLifecycle({
        symbol, exchange, tf, tfSeconds: getTfSeconds(tf),
      })
    }
    return () => { lifecycleRef.current?.destroy() }
  }, [symbol, exchange, tf])

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0e0e0e' }, textColor: '#b3b3b3', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' }, horzLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' } },
      rightPriceScale: { borderColor: '#1f1f1f', scaleMargins: { top: 0.05, bottom: 0.15 }, textColor: '#666666' },
      timeScale: { borderColor: '#1f1f1f', timeVisible: true, visible: true, barSpacing: 6, rightOffset: 12, fixLeftEdge: false, fixRightEdge: false },
      handleScroll: true,
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        pinch: true,
        mouseWheel: true,
      },
      kineticScroll: { touch: false, mouse: false },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR(), downColor: DOWN_COLOR(),
      borderUpColor: UP_BORDER(), borderDownColor: DOWN_BORDER(),
      wickUpColor: UP_COLOR(), wickDownColor: DOWN_COLOR(),
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor: UP_COLOR(),
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', priceLineVisible: false, lastValueVisible: false })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.9, bottom: 0 }, textColor: '#666666' })

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

    const onWheel = (e: WheelEvent) => {
      // Capture phase: run BEFORE lightweight-charts' own wheel listener on
      // the canvas and stopPropagation, so the native zoom (which would zoom
      // a second time, anchored elsewhere) never fires.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        if (containerRef.current) {
          applyCursorAnchoredZoom(chart, containerRef.current, e.clientX, e.deltaY)
        }
      }
    }
    containerRef.current.addEventListener('wheel', onWheel, { passive: false, capture: true })

    return () => {
      destroyedRef.current = true
      containerRef.current?.removeEventListener('wheel', onWheel, { capture: true })
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [symbol, tf, pricePrecision])

  const { isInitialLoading, status, dataVersion } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, { limit: 1000, visibleBars: chartVisibleBars ?? 450, fitOnOpen: chartVisibleBars == null }, lastUpdateRef, lifecycleRef, chartVersion)

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

  const liveIndicator = useLiveIndicator(lastUpdateRef)
  const isStale = useStaleDataDetection(lastUpdateRef)

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef, chartRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef, chartRef)
  useLazyScroll(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, setIsLoadingMore, lifecycleRef, shiftLogicalOffset)
  useSeriesSelfHeal(chartRef, candleRef, volumeRef, destroyedRef, candlesDataRef, adjustingRef)



  useEffect(() => {
    setSelection(null)
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

        // DIAG-c2a4: LWC may return BusinessDay {year,month,day} on 1h+ TFs
        // for coordinateToTime. Normalise to UNIX-seconds before the
        // subtraction — `as number` is a TS-only cast and would yield NaN.
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
  }, [symbol, tf, activeTool, drawingClickHandler, drawingMouseDownHandler, drawingMouseMoveHandler, drawingMouseUpHandler, deactivateTool, isDraggingRef])

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
  }, [primitiveRef])

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0e0e0e]">
      <ExpandedChartHeader symbol={symbol} onBack={onBack} activeTool={activeTool} chartExchange={chartExchange} />
      <div ref={containerRef} className="relative flex-1 min-h-0 [transform:translateZ(0)] [backface-visibility:hidden] [contain:paint]">
        {isInitialLoading && <ChartCornerSpinner />}
        {!isInitialLoading && <LiveIndicator isLive={liveIndicator.isLive} lastUpdate={liveIndicator.lastUpdate} hasReceivedData={liveIndicator.hasReceivedData} />}
        {!isInitialLoading && isLoadingMore && (
          <div className="absolute top-[8px] left-[8px] z-30 pointer-events-none">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-[4px] bg-[#1a1a1a]/95 border border-[#2a2a2a] shadow-lg">
              <div className="w-[12px] h-[12px] border-2 border-[#555] border-t-[#ccc] rounded-full animate-spin" />
              <span className="text-[11px] text-[#aaa] font-medium">Загрузка истории...</span>
            </div>
          </div>
        )}
        {isStale && <StaleDataOverlay visible={true} />}
        {status === 'empty' && <ChartMessageOverlay label="Нет данных для этого таймфрейма" />}
        {status === 'error' && <ChartMessageOverlay label="Ошибка загрузки данных. Попробуйте другой таймфрейм." tone="error" />}

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
                left: Math.min(
                  Math.max(selection.endX + 10, 0),
                  (containerRef.current?.clientWidth ?? 9999) - 180,
                ),
                top: Math.min(
                  Math.max(selection.endY + 10, 0),
                  (containerRef.current?.clientHeight ?? 9999) - 70,
                ),
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
                    Δ {formatDuration(selection.durationSec)}
                  </div>
                </>
              ) : (
                <span>Выделите диапазон</span>
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
  const prevTopRef = useRef<string[]>([])
  const topSymbols = useMemo(() => {
    const next = sortedCoins.slice(pageIndex * 9, pageIndex * 9 + 9).map(c => c.symbol)
    if (next.length === prevTopRef.current.length && next.every((s, i) => s === prevTopRef.current[i])) {
      return prevTopRef.current
    }
    prevTopRef.current = next
    return next
  }, [sortedCoins, pageIndex])
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const expandChart = useCoinListStore(s => s.expandChart)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const chartExchange = useCoinListStore(s => s.chartExchange)

  useInitialCandlesPush()

  useEffect(() => {
    if (topSymbols.length === 0) return
    getOrFetchBulk(topSymbols, tf, GRID_CANDLE_LIMIT, chartExchange)
  }, [topSymbols, tf, chartExchange])

  if (expandedSymbol) {
    return <ExpandedChart symbol={expandedSymbol} onBack={() => expandChart(null)} chartExchange={chartExchange} />
  }

  // Each chart shows itself as soon as its own data is ready (per-cell spinner
  // inside MiniChart). Previously a full-grid blur overlay waited for ALL 9
  // charts, so one slow symbol blocked everything.
  // NB: key intentionally excludes `tf` — see MiniChart's createChart effect.
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
