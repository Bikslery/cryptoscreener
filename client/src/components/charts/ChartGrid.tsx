import { useEffect, useRef, memo, useState, useMemo } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore, setLivePrice } from '../../store'
import { useSmoothedPriceRef } from '../../hooks/useSmoothedPrice'
import type { ChartExchange } from '../../store'
import { useShallow } from 'zustand/shallow'
import { wsOnChannel, wsOnType, wsSubscribe, wsUnsubscribe, getWsOpenCount } from '../../services/ws'
import type { Timeframe, UnifiedCandle, Exchange, DrawingTool } from '../../types'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { ArrowLeft } from 'lucide-react'
import * as candleCache from '../../services/candle-cache'
import { getOrFetchHistory, getOrFetchOlder, getOrFetchBulk, GRID_CANDLE_LIMIT, EXPANDED_CANDLE_LIMIT } from '../../services/candle-prefetch'
import { expandCompactCandles, type CompactCandle } from '../../services/candle-compact'
import { UP_COLOR, DOWN_COLOR, UP_COLOR_VOL, DOWN_COLOR_VOL, UP_BORDER, DOWN_BORDER } from './chart-colors'
import { createCandleEvents, toChartTime, type CandleEvents, type ChartEventPatch, type TickPayload } from '../../services/candle-events'
import { captureViewport, restoreViewport, saveViewport, getViewport } from '../../services/chart-viewport'
import { isFiniteOHLCV, validateCandle } from '../../services/candle-utils'
import { useDrawings } from './useDrawings'
import DrawingToolsPanel from './DrawingToolsPanel'


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

function applyChartPatch(
  patch: ChartEventPatch,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
) {
  for (const u of patch.updates) {
    const bar = u.bar
    const t = toChartTime(bar.time) as Time
    try {
      candleRef.current?.update({ time: t, open: bar.open, high: bar.high, low: bar.low, close: bar.close })
      if (u.paintVolume) {
        volumeRef.current?.update({
          time: t, value: bar.volume,
          color: bar.close >= bar.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
        })
      }
    } catch {
      // Series was recreated mid-paint (pricePrecision flip) — the next
      // history load repaints everything.
    }
    upsertBar(candlesDataRef, bar)
  }
  if (patch.livePrice != null) {
    setLivePrice(symbol, patch.livePrice)
  }
  if (patch.cacheWrites && exchange) {
    for (const c of patch.cacheWrites) {
      candleCache.updateCandle(exchange, symbol, tf, c)
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

function LiveIndicator({ isLive, lastUpdate, hasReceivedData }: { isLive: boolean; lastUpdate: number; hasReceivedData: boolean }) {
  // Staleness is re-derived on a 1s tick instead of Date.now() during render
  // (component purity) — the indicator still reacts within a second of the
  // feed going stale.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const timeSinceUpdate = now - lastUpdate
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

type FullHistoryStatus = 'loading' | 'ready' | 'empty' | 'error'

function useFullHistory(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  options?: { limit?: number; visibleBars?: number; fitOnOpen?: boolean; forceServer?: boolean; wsEpoch?: number },
  lastUpdateRef?: React.RefObject<number>,
  eventsRef?: React.RefObject<CandleEvents | null>,
  chartVersion?: number,
): { isInitialLoading: boolean; status: FullHistoryStatus; dataVersion: number } {
  const limit = options?.limit ?? 1000
  const forceServer = options?.forceServer ?? false
  const wsEpoch = options?.wsEpoch ?? 0
  const fitOnOpen = options?.fitOnOpen ?? false
  const visibleBars = options?.visibleBars ?? 150
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [status, setStatus] = useState<FullHistoryStatus>('loading')
  const [dataVersion, setDataVersion] = useState(0)

  // Key of the last painted series — used to save the viewport we are about
  // to leave and to know whether a reload is a same-key refresh.
  const lastPaintedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!exchange) return
    const cancelled = { value: false }
    const sameKeyReload = forceServer && lastPaintedKeyRef.current === `${exchange}:${symbol}:${tf}`
    if (!sameKeyReload) setIsInitialLoading(true)

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
      const candleData = valid.map(c => ({
        time: toChartTime(c.time) as Time, open: c.open, high: c.high, low: c.low, close: c.close,
      }))
      const volumeData = valid.map(c => ({
        time: toChartTime(c.time) as Time, value: c.volume,
        color: c.close >= c.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
      }))
      try {
        // Capture BEFORE setData — setData resets the whole time scale.
        const leavingKey = lastPaintedKeyRef.current
        if (leavingKey && leavingKey === key) {
          saveViewport(leavingKey, captureViewport(chartRef.current))
        }
        candleRef.current.setData(candleData)
        volumeRef.current.setData(volumeData)
      } catch { /* benign: setData may throw on a fresh/empty series */ }
      if (ts && candleData.length > 0) {
        const saved = getViewport(key)
        if (saved) {
          // Restore the pair's saved viewport (scroll position, bar spacing,
          // right offset, time visibility) — scalpboard's ae() equivalent.
          restoreViewport(chartRef.current, saved)
        } else if (fitOnOpen) {
          // Expanded chart: open maximally zoomed out.
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
        if (flush && flush.updates.length > 0) {
          applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, symbol, exchange, tf)
        }
      }
    }

    const run = async () => {
      // Reconcile: buffer live events while the history loads.
      eventsRef?.current?.setBuffered(true)

      const cached = candleCache.getCandles(exchange, symbol, tf)
      if (!forceServer && cached && cached.length >= limit) {
        if (!cancelled.value && !destroyedRef.current) {
          renderCandles(cached)
          setIsInitialLoading(false)
          setStatus('ready')
          if (lastUpdateRef) lastUpdateRef.current = Date.now()
        }
        return
      }

      // Fetch with scalpboard-style retry backoff (100ms → 300ms): a
      // transient REST failure must not leave the chart blank forever.
      let fetched: UnifiedCandle[] = []
      for (const delay of [0, 100, 300]) {
        if (delay > 0) await new Promise(r => setTimeout(r, delay))
        if (cancelled.value || destroyedRef.current) {
          eventsRef?.current?.setBuffered(false)
          return
        }
        fetched = await getOrFetchHistory(symbol, tf, limit, exchange, forceServer)
        if (fetched.length > 0) break
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
      } else {
        // Server answered without candles (or every retry failed): release
        // the buffer so the forming candle can still paint from live events.
        eventsRef?.current?.setBuffered(false)
        setIsInitialLoading(false)
        setStatus('empty')
      }
    }

    run()
    return () => { cancelled.value = true }
    // `chartVersion` re-paints history when the canvas/series is recreated
    // (pricePrecision flip) — the new chart starts empty.
    // `wsEpoch` re-paints after a WS reconnect so periods that fell through
    // the dead window are restored from the server.
  }, [symbol, exchange, tf, chartVersion, wsEpoch, limit, forceServer, fitOnOpen, visibleBars,
    candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, lastUpdateRef, eventsRef])

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
          if (flush && flush.updates.length > 0) {
            applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf)
          }
          return
        }

        adjustingRef.current = true
        try {
          candlesDataRef.current = merged
          const candleData = merged.map(c => ({
            time: toChartTime(c.time) as Time, open: c.open, high: c.high, low: c.low, close: c.close,
          }))
          const volumeData = merged.map(c => ({
            time: toChartTime(c.time) as Time, value: c.volume,
            color: c.close >= c.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
          }))
          onLogicalShiftRef.current?.(added)
          candleRef.current?.setData(candleData)
          volumeRef.current?.setData(volumeData)
          // End reconciliation: replay any live events captured since the
          // fetch started ON TOP of the merged history.
          const flush = eventsRef?.current?.setBuffered(false)
          if (flush && flush.updates.length > 0) {
            applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf)
          }
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
            if (flush && flush.updates.length > 0) {
              applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf)
            }
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
          if (flush && flush.updates.length > 0) {
            applyChartPatch(flush, candleRef, volumeRef, candlesDataRef, curSymbol, curExchange, curTf)
          }
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

function useLiveIndicator(
  lastUpdateRef: React.RefObject<number>
): { isLive: boolean; lastUpdate: number; hasReceivedData: boolean } {
  const [state, setState] = useState({ isLive: true, lastUpdate: 0, hasReceivedData: false })
  const mountTimeRef = useRef(0)

  useEffect(() => {
    mountTimeRef.current = Date.now()
    const tick = () => {
      const now = Date.now()
      const timeSinceUpdate = now - lastUpdateRef.current
      const hasReceivedData = lastUpdateRef.current > mountTimeRef.current
      setState({
        isLive: timeSinceUpdate < 3000,
        lastUpdate: lastUpdateRef.current,
        hasReceivedData
      })
    }
    // Tick immediately so the very first paint reflects real feed state.
    tick()
    const interval = setInterval(tick, 500)

    return () => clearInterval(interval)
  }, [lastUpdateRef])

  return state
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
      const shouldBeStale = elapsed > threshold
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
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
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
      if (adjustingRef?.current) return

      applyChartPatch(patch, candleRef, volumeRef, candlesDataRef, symbol, exchange, tf)
    })
    wsSubscribe(channel)
    return () => {
      unsub()
      wsUnsubscribe(channel)
    }
  }, [symbol, exchange, tf, adjustingRef, candleRef, candlesDataRef, destroyedRef, eventsRef, lastUpdateRef, volumeRef])
}

function useWsTrade(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  eventsRef: React.RefObject<CandleEvents | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
  lastUpdateRef?: React.RefObject<number>,
) {
  // The price lane (bookTicker mid) is the primary tick source — like
  // scalpboard's single price stream. The trade lane only kicks in when the
  // mid has been quiet for a second, so two prices never alternate on the
  // same forming bar.
  const lastMidTickAtRef = useRef(0)

  useEffect(() => {
    if (!exchange) return
    const tradeType = `trade:${exchange}:${symbol}`

    const unsub = wsOnType(tradeType, (msg) => {
      if (destroyedRef.current) return

      const trade = (msg as { data?: { price: string | number; time?: number } | null }).data
      if (!trade?.price) return

      if (lastUpdateRef) {
        lastUpdateRef.current = Date.now()
      }

      const price = typeof trade.price === 'number' ? trade.price : parseFloat(trade.price)
      if (!isFinite(price)) return

      // The mid lane is fresher — skip the trade print entirely.
      if (Date.now() - lastMidTickAtRef.current < 1000) return

      const tradeTime = typeof trade.time === 'number' && isFinite(trade.time)
        ? trade.time
        : Math.floor(Date.now() / 1000)

      const ev = eventsRef.current
      if (!ev) return

      // Price tick → mutate ONLY the last bar's close/high/low (scalpboard's
      // En). Volume never comes from trades.
      const patch = ev.applyTick({ price, timeSec: tradeTime } as TickPayload)
      if (adjustingRef?.current) return

      applyChartPatch(patch, candleRef, volumeRef, candlesDataRef, symbol, exchange, tf)
    })
    wsSubscribe(tradeType)

    // Fast-lane price: bookTicker mid — the scalpboard-style "live" feel.
    // Exchange filter: the channel is keyed by symbol only; only the
    // matching exchange's mid reaches this chart.
    const priceChannel = `price:${symbol}`
    const unsubPrice = wsOnChannel(priceChannel, (msg) => {
      if (destroyedRef.current) return
      const d = msg.data as { symbol: string; exchange?: string; price: number } | undefined
      if (!d || typeof d.price !== 'number' || !isFinite(d.price) || d.price <= 0) return
      if (exchange && d.exchange && d.exchange !== exchange) return
      lastMidTickAtRef.current = Date.now()

      const ev = eventsRef.current
      if (!ev || adjustingRef?.current) return

      const patch = ev.applyTick({ price: d.price, timeSec: Math.floor(Date.now() / 1000) } as TickPayload)
      applyChartPatch(patch, candleRef, volumeRef, candlesDataRef, symbol, exchange, tf)
    })
    wsSubscribe(priceChannel)

    return () => {
      unsub()
      wsUnsubscribe(tradeType)
      unsubPrice()
      wsUnsubscribe(priceChannel)
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
  const lastUpdateRef = useRef(0)
  const [chartVersion, setChartVersion] = useState(0)

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

    return () => {
      destroyedRef.current = true
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
    // NB: `tf` is deliberately NOT a dependency — a timeframe switch only
    // needs new data (useFullHistory handles setData + visible range), not a
    // full chart destroy/recreate.
  }, [symbol, pricePrecision])

  const [wsCount, setWsCount] = useState(getWsOpenCount)
  const [mountWsCount] = useState(() => getWsOpenCount())
  useEffect(() => {
    const un = wsOnType('open', () => setWsCount(getWsOpenCount()))
    return un
  }, [])

  const { isInitialLoading, status, dataVersion } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, {
    limit: GRID_CANDLE_LIMIT,
    forceServer: wsCount > mountWsCount,
    wsEpoch: wsCount,
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

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useLazyScroll(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, undefined, eventsRef, shiftLogicalOffset)

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
  // Smoothed price display (presentation only — chart/store data stays exact).
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
  const lastUpdateRef = useRef(0)
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

    return () => {
      destroyedRef.current = true
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [symbol, tf, pricePrecision])

  const [wsCount, setWsCount] = useState(getWsOpenCount)
  const [mountWsCount] = useState(() => getWsOpenCount())
  useEffect(() => {
    const un = wsOnType('open', () => setWsCount(getWsOpenCount()))
    return un
  }, [])

  const { isInitialLoading, status, dataVersion } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, {
    limit: EXPANDED_CANDLE_LIMIT,
    fitOnOpen: true,
    forceServer: wsCount > mountWsCount,
    wsEpoch: wsCount,
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

  const liveIndicator = useLiveIndicator(lastUpdateRef)
  const isStale = useStaleDataDetection(lastUpdateRef)

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, eventsRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
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

  useEffect(() => {
    if (topSymbols.length === 0) return
    getOrFetchBulk(topSymbols, tf, GRID_CANDLE_LIMIT, chartExchange)
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