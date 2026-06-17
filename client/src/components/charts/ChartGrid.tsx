import { useEffect, useRef, memo, useState, useMemo } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore, useLivePrice, setLivePrice } from '../../store'
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
import { useDrawings } from './useDrawings'
import DrawingToolsPanel from './DrawingToolsPanel'


const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}
function getTfSeconds(tf: Timeframe): number { return TF_SECONDS[tf] || 60 }

function applyChartPatch(
  patch: CandlePatch,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candlesDataRef?: React.RefObject<UnifiedCandle[]>,
) {
  for (const raw of patch.candleUpdates) {
    const c = normalizeCandle(raw)
    if (!isFiniteOHLCV(c)) continue
    candleRef.current?.update({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    })
  }
  for (const raw of patch.volumeUpdates) {
    const v = normalizeCandle(raw)
    if (!isFinite(v.volume)) continue
    volumeRef.current?.update({
      time: v.time as Time, value: v.volume,
      color: v.close >= v.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
    })
  }
  if (patch.livePrice != null) {
    setLivePrice(symbol, patch.livePrice)
  }
  if (patch.cacheWrites && exchange) {
    for (const c of patch.cacheWrites) {
      candleCache.updateCandle(exchange, symbol, tf, normalizeCandle(c))
    }
  }
  if (candlesDataRef?.current && patch.candleUpdates.length > 0) {
    const arr = candlesDataRef.current
    for (const c of patch.candleUpdates) {
      const last = arr[arr.length - 1]
      if (last && last.time === c.time) {
        arr[arr.length - 1] = c
      } else if (!last || c.time > last.time) {
        arr.push(c)
      }
    }
  }
  const lastCandle = patch.candleUpdates[patch.candleUpdates.length - 1]
  if (lastCandle) {
    candleRef.current?.applyOptions({
      priceLineColor: lastCandle.close >= lastCandle.open ? UP_COLOR() : DOWN_COLOR(),
    })
  }
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
      applyChartPatch(patch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef)
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
  options?: { limit?: number },
  lastUpdateRef?: React.RefObject<number>,
  lifecycleRef?: React.RefObject<CandleLifecycle | null>,
): { isInitialLoading: boolean; status: 'loading' | 'ready' | 'empty' | 'error' } {
  const limit = options?.limit ?? 1000
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')

  useEffect(() => {
    if (!exchange) return
    const cancelled = { value: false }
    setIsInitialLoading(true)
    setStatus('loading')

    const renderCandles = (candles: UnifiedCandle[]) => {
      if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
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
      try {
        candleRef.current.setData(candleData)
        volumeRef.current.setData(volumeData)
        const ts = chartRef.current?.timeScale()
        if (ts && candleData.length > 0) {
          const lastBar = candleData.length - 1
          const visibleBars = 150
          ts.setVisibleLogicalRange({ from: lastBar - visibleBars, to: lastBar + 5 })
        }
      } catch {}
      if (lifecycleRef && validCandles.length > 0) {
        lifecycleRef.current?.applyHistory(validCandles)
      }
    }

    const run = async () => {
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
        if (cancelled.value || destroyedRef.current) return
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
          setIsInitialLoading(false)
          setStatus('empty')
        }
      } catch {
        setIsInitialLoading(false)
        setStatus('error')
      }
    }

    run()
    return () => { cancelled.value = true }
  }, [symbol, exchange, tf])

  return { isInitialLoading, status }
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
      // This is fire-and-forget — no chart redraw, just warming the cache.
      const prefetchThreshold = Math.max(200, visibleBars * 1.5)
      if (range.from < prefetchThreshold && !prefetchInflightRef.current) {
        const curSymbol = symbolRef.current
        const curExchange = exchangeRef.current
        const curTf = tfRef.current
          if (curExchange) {
            const cached = candleCache.getCandles(curExchange, curSymbol, curTf)
            if (cached && cached.length > 0) {
              prefetchInflightRef.current = true
              getOrFetchOlder(curSymbol, curTf, cached[0].time, 1000, curExchange)
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

      // Clamp visible range during inflight — prevents scrolling into empty space
      {
        const ts = chartRef.current?.timeScale()
        const curRange = ts?.getVisibleLogicalRange()
        if (ts && curRange && curRange.from < 0) {
          ts.setVisibleLogicalRange({ from: 0, to: curRange.to })
        }
      }

      const cached = candleCache.getCandles(curExchange, curSymbol, curTf)
      if (!cached || cached.length === 0) {
        inflightRef.current = false
        setIsLoadingMore?.(false)
        return
      }

      const before = cached[0].time

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

          const chart = chartRef.current
          const ts = chart?.timeScale()
          if (!chart || !ts) {
            inflightRef.current = false
            setIsLoadingMore?.(false)
            return
          }

          const prevRange = ts.getVisibleLogicalRange()
          const prevLen = candlesDataRef.current.length
          candlesDataRef.current = merged
          const added = merged.length - prevLen

          if (added <= 0) {
            inflightRef.current = false
            setIsLoadingMore?.(false)
            return
          }

          adjustingRef.current = true
          lifecycleRef?.current?.setBuffered(true)

          const barSpacing = (ts.options() as any).barSpacing

          try {
            const normalized = merged.map(normalizeCandle)
            const candleData = normalized.map(c => ({
              time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
            }))
            const volumeData = normalized.map(c => ({
              time: c.time as Time, value: c.volume,
              color: c.close >= c.open ? UP_COLOR_VOL() : DOWN_COLOR_VOL(),
            }))
            candleRef.current?.setData(candleData)
            volumeRef.current?.setData(volumeData)

            lifecycleRef?.current?.applyHistory(merged)
            const flushPatch = lifecycleRef?.current?.setBuffered(false)
            if (flushPatch && flushPatch.candleUpdates.length > 0) {
              applyChartPatch(flushPatch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef)
            }

            if (barSpacing != null) {
              ts.applyOptions({ barSpacing })
            }

            if (prevRange) {
              ts.setVisibleLogicalRange({
                from: prevRange.from + added,
                to: prevRange.to + added,
              })
            }
          } catch (err) {
            console.error('[ChartGrid] setData failed during lazy scroll', { symbol, tf, error: err })
          } finally {
            adjustingRef.current = false
          }
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

      applyChartPatch(patch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef)
      if (patch.gapBackfill) {
        backfillGap(patch.gapBackfill, symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef)
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

      applyChartPatch(patch, candleRef, volumeRef, symbol, exchange, tf, candlesDataRef)
      if (patch.gapBackfill) {
        backfillGap(patch.gapBackfill, symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef)
      }
    })
    wsSubscribe(tradeType)

    return () => {
      unsub()
      wsUnsubscribe(tradeType)
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
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        const ts = chart.timeScale()
        const options = ts.options()
        const currentSpacing = (options as any).barSpacing || 6
        const delta = e.deltaY > 0 ? -0.5 : 0.5
        const newSpacing = Math.max(1, Math.min(30, currentSpacing + delta))
        ts.applyOptions({ barSpacing: newSpacing })
      }
    }
    containerRef.current.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      destroyedRef.current = true
      containerRef.current?.removeEventListener('wheel', onWheel)
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

  const { isInitialLoading, status } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, { limit: GRID_CANDLE_LIMIT }, lastUpdateRef, lifecycleRef)

  const adjustingRef = useRef(false)

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useLazyScroll(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, undefined, lifecycleRef)

  const {
    activeTool,
    setActiveTool,
    removeDrawing,
    clearAllDrawings,
    hasDrawings,
    handleClick: drawingClickHandler,
    handleMouseMove: drawingMouseMoveHandler,
    deactivateTool,
    pendingPoint,
    pendingPointPixel,
    previewLine,
    primitiveRef,
    CLICK_THRESHOLD,
  } = useDrawings(symbol, tf, chartRef, candleRef, containerRef, candlesDataRef, chartVersion, isInitialLoading)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let mouseDownX = 0
    let mouseDownY = 0
    let restoreOpts: { handleScroll?: boolean; handleScale?: boolean } | null = null

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || activeTool === null) return
      const chart = chartRef.current
      if (!chart) return
      mouseDownX = e.clientX - container.getBoundingClientRect().left
      mouseDownY = e.clientY - container.getBoundingClientRect().top
      restoreOpts = { handleScroll: true, handleScale: true }
      chart.applyOptions({ handleScroll: false, handleScale: false })
    }

    const onMouseMove = (e: MouseEvent) => {
      if (activeTool === null) return
      drawingMouseMoveHandler(e)
    }

    const restoreDrawingScroll = () => {
      const chart = chartRef.current
      if (chart && restoreOpts) {
        chart.applyOptions(restoreOpts)
        restoreOpts = null
      }
    }

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || activeTool === null) return
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
  }, [activeTool, drawingClickHandler, drawingMouseMoveHandler, deactivateTool, CLICK_THRESHOLD])

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
    {(pendingPointPixel || previewLine) && (
      <svg
        className="pointer-events-none absolute inset-0 z-20"
        style={{ overflow: 'visible' }}
      >
        {pendingPointPixel && previewLine && (
          <line
            x1={previewLine.x1}
            y1={previewLine.y1}
            x2={previewLine.x2}
            y2={previewLine.y2}
            stroke="#fff"
            strokeWidth={1}
            strokeDasharray="4 3"
            strokeOpacity={0.5}
          />
        )}
        {pendingPointPixel && (
          <circle
            cx={pendingPointPixel.x}
            cy={pendingPointPixel.y}
            r={3}
            fill="#fff"
            stroke="#0e0e0e"
            strokeWidth={1}
          />
        )}
      </svg>
    )}
    <DrawingToolsPanel
      activeTool={activeTool}
      setActiveTool={setActiveTool}
      clearAllDrawings={clearAllDrawings}
      hasDrawings={hasDrawings}
      pendingPoint={pendingPoint}
    />
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
  const livePrice = useLivePrice(symbol)
  const price = livePrice ?? coin?.price ?? 0
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

      <span className="font-mono font-bold text-[13px] text-[#e0e0e0]">{price ? `$${formatPrice(price, precision)}` : ''}</span>

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
            {activeTool === 'h-ray' ? 'Гориз. луч' : activeTool === 't-ray' ? 'Тренд. луч' : 'Отрезок'} — клик на графике | Esc — отмена
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
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        const ts = chart.timeScale()
        const options = ts.options()
        const currentSpacing = (options as any).barSpacing || 6
        const delta = e.deltaY > 0 ? -0.5 : 0.5
        const newSpacing = Math.max(1, Math.min(30, currentSpacing + delta))
        ts.applyOptions({ barSpacing: newSpacing })
      }
    }
    containerRef.current.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      destroyedRef.current = true
      containerRef.current?.removeEventListener('wheel', onWheel)
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [symbol, tf, pricePrecision])

  const { isInitialLoading, status } = useFullHistory(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, { limit: 1000 }, lastUpdateRef, lifecycleRef)

  const {
    activeTool,
    setActiveTool,
    removeDrawing,
    clearAllDrawings,
    hasDrawings,
    deactivateTool,
    handleClick: drawingClickHandler,
    handleMouseMove: drawingMouseMoveHandler,
    pendingPoint,
    pendingPointPixel,
    previewLine,
    primitiveRef,
    CLICK_THRESHOLD,
  } = useDrawings(symbol, tf, chartRef, candleRef, containerRef, candlesDataRef, chartVersion, isInitialLoading)

  const liveIndicator = useLiveIndicator(lastUpdateRef)
  const isStale = useStaleDataDetection(lastUpdateRef)

  useWsCandle(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useWsTrade(symbol, exchange, tf, candleRef, volumeRef, lifecycleRef, destroyedRef, candlesDataRef, adjustingRef, lastUpdateRef)
  useLazyScroll(symbol, exchange, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, setIsLoadingMore, lifecycleRef)



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

      if (e.button === 0 && activeTool !== null) {
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
  }, [symbol, tf, activeTool, drawingClickHandler, drawingMouseMoveHandler, deactivateTool])

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
        {(pendingPointPixel || previewLine) && (
          <svg
            className="pointer-events-none absolute inset-0 z-20"
            style={{ overflow: 'visible' }}
          >
            {pendingPointPixel && previewLine && (
              <line
                x1={previewLine.x1}
                y1={previewLine.y1}
                x2={previewLine.x2}
                y2={previewLine.y2}
                stroke="#fff"
                strokeWidth={1}
                strokeDasharray="4 3"
                strokeOpacity={0.5}
              />
            )}
            {pendingPointPixel && (
              <circle
                cx={pendingPointPixel.x}
                cy={pendingPointPixel.y}
                r={3}
                fill="#fff"
                stroke="#0e0e0e"
                strokeWidth={1}
              />
            )}
          </svg>
        )}

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
