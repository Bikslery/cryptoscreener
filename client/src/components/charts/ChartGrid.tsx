import { useEffect, useRef, memo, useState, useCallback, useMemo } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore, useLivePrice, setLivePrice } from '../../store'
import { useShallow } from 'zustand/shallow'
import { debounce } from '../../utils/debounce'
import { wsOnChannel, wsOnType, wsSubscribe, wsUnsubscribe } from '../../services/ws'
import type { Timeframe, UnifiedCandle } from '../../types'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { ArrowLeft } from 'lucide-react'
import * as candleCache from '../../services/candle-cache'
import { getOrFetchHistory, getOrFetchOlder, getOrFetchBulk } from '../../services/candle-prefetch'
import { useDrawings, type DrawingTool } from './useDrawings'
import DrawingToolsPanel from './DrawingToolsPanel'

const UP_COLOR = '#26a65b'
const DOWN_COLOR = '#e74c3c'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}
function getTfSeconds(tf: Timeframe): number { return TF_SECONDS[tf] || 60 }

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

let initialPushReceived = false

function useInitialCandlesPush() {
  useEffect(() => {
    const unsubReconnect = wsOnType('open', () => {
      initialPushReceived = false
    })
    const unsubPush = wsOnType('initial-candles', (msg) => {
      if (initialPushReceived) return
      initialPushReceived = true
      const data = msg.data as Record<string, UnifiedCandle[]> | undefined
      if (!data) return
      candleCache.storeBulk(data)
    })
    return () => { unsubReconnect(); unsubPush() }
  }, [])
}

function useFullHistory(
  symbol: string,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  options?: { limit?: number },
): { isInitialLoading: boolean; status: 'loading' | 'ready' | 'empty' | 'error' } {
  const limit = options?.limit ?? 1000
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')

  useEffect(() => {
    const cancelled = { value: false }
    setIsInitialLoading(true)
    setStatus('loading')

    const renderCandles = (candles: UnifiedCandle[]) => {
      if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
      candlesDataRef.current = candles
      // Filter out invalid candles before rendering
      const validCandles = candles.filter(c =>
        isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) &&
        isFinite(c.volume) && c.volume >= 0 && c.time > 0
      )
      const candleData = validCandles.map(c => ({
        time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
      }))
      const volumeData = validCandles.map(c => ({
        time: c.time as Time, value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
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
    }

    const run = async () => {
      // Fast path: check client cache
      const cached = candleCache.getCandles(symbol, tf)
      if (cached && cached.length > 0) {
        renderCandles(cached)
        setIsInitialLoading(false)
        setStatus('ready')
        return
      }

      // Fallback: individual fetch (server does seamless stitching)
      try {
        const fetched = await getOrFetchHistory(symbol, tf, limit)
        if (cancelled.value || destroyedRef.current) return
        if (fetched.length > 0) {
          renderCandles(fetched)
          setIsInitialLoading(false)
          setStatus('ready')
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
  }, [symbol, tf])

  return { isInitialLoading, status }
}

function useLazyScroll(
  symbol: string,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  isInitialLoading: boolean,
  adjustingRef: React.RefObject<boolean>,
  setIsLoadingMore?: (loading: boolean) => void,
) {
  const inflightRef = useRef(false)
  const reachedStartRef = useRef(false)
  const symbolRef = useRef(symbol)
  const tfRef = useRef(tf)
  const emptyCountRef = useRef(0)

  useEffect(() => {
    symbolRef.current = symbol
    tfRef.current = tf
    reachedStartRef.current = false
    inflightRef.current = false
    adjustingRef.current = false
    emptyCountRef.current = 0
  }, [symbol, tf])

  // Bug 3: debounce onRange — avoid dozens of redundant checks per second during fast scroll
  const onRangeDebounced = useMemo(
    () => debounce((range: { from: number; to: number } | null) => {
      if (!range || adjustingRef.current || inflightRef.current || reachedStartRef.current) return

      // Dynamic threshold: start loading when approaching edge
      // Bug 1a: use 60% of visible range or minimum 300 bars (was 30%/100)
      const visibleBars = range.to - range.from
      const threshold = Math.max(300, visibleBars * 0.6)

      if (range.from > threshold) return

      const curSymbol = symbolRef.current
      const curTf = tfRef.current

      inflightRef.current = true
      setIsLoadingMore?.(true)

      // Bug 1c: clamp visible range during inflight — prevents scrolling into empty space
      // while older data is being fetched
      {
        const ts = chartRef.current?.timeScale()
        const curRange = ts?.getVisibleLogicalRange()
        if (ts && curRange && curRange.from < 0) {
          ts.setVisibleLogicalRange({ from: 0, to: curRange.to })
        }
      }

      const cached = candleCache.getCandles(curSymbol, curTf)
      if (!cached || cached.length === 0) {
        inflightRef.current = false
        setIsLoadingMore?.(false)
        return
      }

      const before = cached[0].time

      getOrFetchOlder(curSymbol, curTf, before, 1000)
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

          candleCache.prependCandles(curSymbol, curTf, newCandles)
          const merged = candleCache.getCandles(curSymbol, curTf)
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

          const barSpacing = (ts.options() as any).barSpacing

          try {
            const candleData = merged.map(c => ({
              time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
            }))
            const volumeData = merged.map(c => ({
              time: c.time as Time, value: c.volume,
              color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
            }))
            candleRef.current?.setData(candleData)
            volumeRef.current?.setData(volumeData)

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

          // Bug 1b: prefetch next page proactively if still near the edge
          // This reduces the "empty space" window on continuous fast scroll
          {
            const ts = chartRef.current?.timeScale()
            const curRange = ts?.getVisibleLogicalRange()
            if (ts && curRange && !reachedStartRef.current) {
              const vis = curRange.to - curRange.from
              if (curRange.from < vis * 0.6) {
                const newCached = candleCache.getCandles(curSymbol, curTf)
                if (newCached && newCached.length > 0) {
                  // Fire-and-forget: warm the cache for the next scroll trigger
                  getOrFetchOlder(curSymbol, curTf, newCached[0].time, 1000).catch(() => {})
                }
              }
            }
          }
        })
        .catch((err: Error & { isNetworkError?: boolean }) => {
          // Bug 4: don't increment emptyCountRef on network/server errors
          // Only truly empty responses (HTTP 200 + []) count toward the 3-strike limit
          if (!err?.isNetworkError) {
            emptyCountRef.current++
            if (emptyCountRef.current >= 3) {
              reachedStartRef.current = true
            }
          }
          inflightRef.current = false
          setIsLoadingMore?.(false)
        })
    }, 50),
    [] // stable — reads refs, no reactive deps needed
  )

  useEffect(() => {
    if (isInitialLoading) return
    const chart = chartRef.current
    if (!chart) return
    const ts = chart.timeScale()

    ts.subscribeVisibleLogicalRangeChange(onRangeDebounced)
    return () => { ts.unsubscribeVisibleLogicalRangeChange(onRangeDebounced) }
  }, [symbol, tf, isInitialLoading, onRangeDebounced])
}

function useRafFlush(
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  destroyedRef: React.RefObject<boolean>,
) {
  const pendingCandle = useRef<{ time: Time; open: number; high: number; low: number; close: number } | null>(null)
  const pendingVolume = useRef<{ time: Time; value: number; color: string } | null>(null)
  const rafId = useRef<number | null>(null)
  const lastFlushTime = useRef<number>(0)

  const flush = () => {
    rafId.current = null
    const now = performance.now()
    // Throttle: minimum 16ms between flushes (60fps) to reduce flickering while maintaining smooth updates
    if (now - lastFlushTime.current < 16) {
      rafId.current = requestAnimationFrame(flush)
      return
    }
    lastFlushTime.current = now

    if (destroyedRef.current) {
      pendingCandle.current = null
      pendingVolume.current = null
      return
    }
    const c = pendingCandle.current
    const v = pendingVolume.current
    pendingCandle.current = null
    pendingVolume.current = null
    try {
      if (c && candleRef.current) candleRef.current.update(c)
      if (v && volumeRef.current) volumeRef.current.update(v)
    } catch {}
  }

  const schedule = () => {
    if (rafId.current != null) return
    rafId.current = requestAnimationFrame(flush)
  }

  useEffect(() => () => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current)
    rafId.current = null
  }, [])

  return {
    queueCandle(p: { time: Time; open: number; high: number; low: number; close: number }) {
      // Bug 3b: reject out-of-order — if pending candle is newer, don't overwrite
      const prev = pendingCandle.current
      if (prev && p.time < prev.time) return
      // Merge with pending candle if same time to avoid overwriting newer data
      if (prev && p.time === prev.time) {
        const merged = {
          time: p.time,
          open: prev.open, // Keep original open
          high: Math.max(prev.high, p.high),
          low: Math.min(prev.low, p.low),
          close: p.close, // Use latest close
        }
        // Validate merged candle OHLC relationships
        if (merged.high < merged.low) {
          console.warn('[queueCandle] Invalid merge detected', { prev, p, merged })
          // Fix by ensuring high >= low
          merged.high = Math.max(prev.high, p.high, prev.low, p.low)
          merged.low = Math.min(prev.high, p.high, prev.low, p.low)
        }
        pendingCandle.current = merged
      } else {
        pendingCandle.current = p
      }
      schedule()
    },
    queueVolume(p: { time: Time; value: number; color: string }) {
      pendingVolume.current = p
      schedule()
    },
  }
}

function useWsCandle(
  symbol: string,
  tf: Timeframe,
  flush: ReturnType<typeof useRafFlush>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef?: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
) {
  useEffect(() => {
    const channel = `candle:${symbol}:${tf}`
    const unsub = wsOnChannel(channel, (msg) => {
      if (destroyedRef.current) return
      // Bug 2: skip WS updates while useLazyScroll is doing setData
      if (adjustingRef?.current) return
      const c = msg.data as UnifiedCandle
      if (!c) return

      // Validate OHLC fields before processing
      if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
        console.warn('[useWsCandle] Invalid OHLC data', { symbol, tf, time: c.time })
        return
      }

      // Bug 3a: reject stale/out-of-order candles — if a trade-built candle
      // already has a later time, a delayed WS candle must not overwrite it
      if (candlesDataRef?.current) {
        const arr = candlesDataRef.current
        const last = arr[arr.length - 1]
        if (last && c.time < last.time) return
      }
      if (!c.isFinal) {
        setLivePrice(symbol, c.close)
      }
      candleCache.updateCandle(symbol, tf, c)
      if (candlesDataRef && candlesDataRef.current) {
        const arr = candlesDataRef.current
        const last = arr[arr.length - 1]
        if (last && last.time === c.time) {
          arr[arr.length - 1] = c
        } else if (!last || c.time > last.time) {
          arr.push(c)
        }
      }
      flush.queueCandle({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })
      flush.queueVolume({
        time: c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
      })
    })
    wsSubscribe(channel)
    return () => {
      unsub()
      wsUnsubscribe(channel)
    }
  }, [symbol, tf])
}

function useWsTrade(
  symbol: string,
  tf: Timeframe,
  flush: ReturnType<typeof useRafFlush>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef?: React.RefObject<UnifiedCandle[]>,
  adjustingRef?: React.RefObject<boolean>,
) {
  // Bug 5: useRef instead of let — survives re-renders, reset on symbol/tf change
  const curRef = useRef<UnifiedCandle | null>(null)

  useEffect(() => {
    curRef.current = null
    const tradeType = `trade:${symbol}`

    const unsub = wsOnType(tradeType, (msg) => {
      if (destroyedRef.current) return
      // Bug 2: skip WS updates while useLazyScroll is doing setData
      if (adjustingRef?.current) return
      const trade = msg.data as any
      if (!trade?.price) return
      const price = typeof trade.price === 'number' ? trade.price : parseFloat(trade.price)
      if (!isFinite(price)) return

      // Validate and sanitize trade volume
      const volume = typeof trade.volume === 'number' && isFinite(trade.volume) && trade.volume >= 0
        ? trade.volume
        : 0

      // Bug 2a: push trade price to live-price store — redundancy for ticker batch lag
      setLivePrice(symbol, price)

      const now = Math.floor(Date.now() / 1000)
      const tfSeconds = getTfSeconds(tf)
      const candleTime = Math.floor(now / tfSeconds) * tfSeconds

      const cur = curRef.current
      if (!cur || cur.time !== candleTime) {
        // Bug 3c: include full UnifiedCandle fields (symbol, exchange, timeframe)
        // so candleCache.updateCandle gets consistent data
        // Copy exchange from last candle in backing array if available
        const lastCandle = candlesDataRef?.current?.[candlesDataRef.current.length - 1]
        curRef.current = {
          symbol, exchange: lastCandle?.exchange ?? ('agg' as any), timeframe: tf,
          time: candleTime, open: price, high: price, low: price, close: price, volume,
        }
      } else {
        if (price > cur.high) cur.high = price
        if (price < cur.low) cur.low = price
        cur.close = price
        cur.volume += volume
      }

      const c = curRef.current!

      // Validate constructed candle before processing
      if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
        console.warn('[useWsTrade] Invalid constructed candle', { symbol, tf, time: c.time })
        return
      }

      // Bug 1: write to cache (was missing)
      candleCache.updateCandle(symbol, tf, c)

      // Bug 1: write to backing array (was missing)
      if (candlesDataRef?.current) {
        const arr = candlesDataRef.current
        const last = arr[arr.length - 1]
        if (last?.time === c.time) arr[arr.length - 1] = { ...c }
        else arr.push({ ...c })
      }

      flush.queueCandle({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })
      // Bug 1: queue volume (was missing)
      flush.queueVolume({
        time: c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
      })
    })
    wsSubscribe(tradeType)

    return () => {
      unsub()
      wsUnsubscribe(tradeType)
    }
  }, [symbol, tf])
}

function exchangeBadge(ex: string): string {
  if (ex.includes('binance') && ex.includes('futures')) return 'BI-F'
  if (ex.includes('binance') && ex.includes('spot')) return 'BI-S'
  if (ex.includes('bybit')) return 'BY-F'
  if (ex.includes('okx') && ex.includes('futures')) return 'OK-F'
  if (ex.includes('okx') && ex.includes('spot')) return 'OK-S'
  return 'EX'
}

const MiniChartHeader = memo(function MiniChartHeader({ symbol }: { symbol: string }) {
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
  const livePrice = useLivePrice(symbol)
  const [flash, setFlash] = useState<'green' | 'red' | null>(null)
  const prevPriceRef = useRef<number | null>(null)

  useEffect(() => {
    if (livePrice == null) return
    const prev = prevPriceRef.current
    prevPriceRef.current = livePrice
    if (prev == null || prev === livePrice) return
    setFlash(livePrice > prev ? 'green' : 'red')
    const t = setTimeout(() => setFlash(null), 300)
    return () => clearTimeout(t)
  }, [livePrice])

  const isUp = coin ? coin.change24h >= 0 : true
  const badge = exchangeBadge(coin?.exchange || '')
  const vol = coin ? formatCompact(coin.quoteVolume24h) : '-'

  return (
    <div className={`relative z-20 flex items-center justify-between px-[6px] py-[3px] border-b border-[#1f1f1f] flex-shrink-0 gap-2 transition-colors duration-300 ${
      flash === 'green' ? 'bg-[#26a65b]/20' : flash === 'red' ? 'bg-[#e74c3c]/20' : 'bg-[#141414]'
    }`}>
      <div className="flex items-center gap-[5px] min-w-0">
        <span className="text-[9px] font-bold px-[3px] py-[1px] rounded-[2px] leading-none bg-[#f9b600]/15 text-[#f9b600] border border-[#f9b600]/30">
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
  symbol, visible, onLoaded,
}: { symbol: string; visible: boolean; onLoaded?: (loadKey: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const priceLineRef = useRef<any>(null)
  const prevPriceRef = useRef<number | null>(null)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const [priceLineVersion, setPriceLineVersion] = useState(0)

  const flush = useRafFlush(candleRef, volumeRef, destroyedRef)

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
      upColor: UP_COLOR, downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR, borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', priceLineVisible: false })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, textColor: '#666666' })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries
    priceLineRef.current = candleSeries.createPriceLine({
      price: 0,
      color: '#26a65b',
      lineStyle: 2, // Dashed
      lineWidth: 1,
      axisLabelVisible: true,
      title: '',
    })
    setPriceLineVersion(v => v + 1)

    const ro = new ResizeObserver(() => {
      if (containerRef.current && !destroyedRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
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
      priceLineRef.current = null
      prevPriceRef.current = null
    }
  }, [symbol, tf, pricePrecision])

  const { isInitialLoading, status } = useFullHistory(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, { limit: 300 })

  useEffect(() => {
    if (!isInitialLoading) onLoaded?.(`${tf}:${symbol}`)
  }, [isInitialLoading, symbol, tf, onLoaded])

  useWsCandle(symbol, tf, flush, destroyedRef, candlesDataRef)
  useWsTrade(symbol, tf, flush, destroyedRef, candlesDataRef)
  usePriceLine(symbol, tf, priceLineRef, prevPriceRef, destroyedRef, priceLineVersion, candlesDataRef)

  // Set initial price line position from loaded data
  useEffect(() => {
    if (isInitialLoading || !priceLineRef.current) return
    const candles = candlesDataRef.current
    if (candles.length === 0) return
    const last = candles[candles.length - 1]
    if (isFinite(last.close) && last.close > 0) {
      const color = last.close >= last.open ? '#26a65b' : '#e74c3c'
      try {
        priceLineRef.current.applyOptions({ price: last.close, color })
        prevPriceRef.current = last.close
      } catch {}
    }
  }, [isInitialLoading, symbol, tf, priceLineVersion])

  return (
    <div
      className={`relative flex flex-col h-full bg-[#0e0e0e] border border-[#1f1f1f] overflow-hidden rounded-[3px] transition-all duration-300 ease-out ${
        visible ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.99]'
      }`}
    >
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 select-none">
        <span className="text-[48px] font-bold text-white/[0.04] tracking-tighter uppercase" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {extractBaseAsset(symbol)}
        </span>
      </div>
      <MiniChartHeader symbol={symbol} />
      <div ref={containerRef} className="relative z-0 flex-1 min-h-0" />
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

const ExpandedChartHeader = memo(function ExpandedChartHeader({ symbol, onBack, activeTool }: { symbol: string; onBack: () => void; activeTool: DrawingTool | null }) {
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
  const badge = exchangeBadge(coin?.exchange || '')
  const precision = coin?.pricePrecision ?? 2
  const volDisplay = coin ? formatCompact(coin.quoteVolume24h) : '-'

  return (
    <div className="flex items-center gap-3 px-3 py-[6px] bg-[#141414] border-b border-[#1f1f1f] flex-shrink-0">
      <button
        className="flex items-center justify-center w-[28px] h-[28px] rounded-[4px] bg-[#1a1a1a] border border-[#2a2a2a] text-[#666] hover:bg-[#222] hover:text-[#ccc] hover:border-[#444] transition-all duration-150"
        onClick={onBack}
        title="Назад к сетке"
      >
        <ArrowLeft size={15} />
      </button>

      <div className="flex items-center gap-[8px] min-w-0">
        <span className="text-[10px] font-bold px-[4px] py-[1px] rounded-[3px] leading-none bg-[#f9b600]/15 text-[#f9b600] border border-[#f9b600]/30">
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

function usePriceLine(
  symbol: string,
  tf: Timeframe,
  priceLineRef: React.RefObject<any>,
  prevPriceRef: React.RefObject<number | null>,
  destroyedRef: React.RefObject<boolean>,
  priceLineVersion: number,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
) {
  const livePrice = useLivePrice(symbol)
  const updateTimerRef = useRef<number | null>(null)
  const pendingPriceRef = useRef<number | null>(null)
  const lastCandleColorRef = useRef<string>('#26a65b')

  const deriveCandleColor = (c: UnifiedCandle) => c.close >= c.open ? '#26a65b' : '#e74c3c'

  useEffect(() => {
    prevPriceRef.current = null
    lastCandleColorRef.current = '#26a65b'
    const candles = candlesDataRef.current
    if (candles.length > 0) {
      const last = candles[candles.length - 1]
      if (last.close != null && last.open != null) {
        lastCandleColorRef.current = deriveCandleColor(last)
      }
    }
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current)
        updateTimerRef.current = null
      }
    }
  }, [symbol, tf])

  useEffect(() => {
    if (livePrice == null || destroyedRef.current || !priceLineRef.current) return

    pendingPriceRef.current = livePrice

    if (updateTimerRef.current) return

    updateTimerRef.current = window.setTimeout(() => {
      updateTimerRef.current = null
      const price = pendingPriceRef.current
      if (price == null || destroyedRef.current || !priceLineRef.current) return

      prevPriceRef.current = price

      try {
        priceLineRef.current.applyOptions({
          price: price,
          color: lastCandleColorRef.current,
        })
      } catch {}
    }, 100)

    // Cleanup timer on unmount or when dependencies change
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current)
        updateTimerRef.current = null
      }
    }
  }, [livePrice, priceLineVersion])

  useEffect(() => {
    const channel = `candle:${symbol}:${tf}`

    const unsubCandle = wsOnChannel(channel, (msg) => {
      if (destroyedRef.current || !priceLineRef.current) return
      const c = msg.data as UnifiedCandle
      if (!c?.close) return

      lastCandleColorRef.current = deriveCandleColor(c)

      if (prevPriceRef.current === null) {
        prevPriceRef.current = c.close
        try {
          priceLineRef.current.applyOptions({
            price: c.close,
            color: lastCandleColorRef.current,
          })
        } catch {}
      } else {
        try {
          priceLineRef.current.applyOptions({
            color: lastCandleColorRef.current,
          })
        } catch {}
      }
    })

    wsSubscribe(channel)

    return () => {
      unsubCandle()
      wsUnsubscribe(channel)
    }
  }, [symbol, tf])
}

function ExpandedChart({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const priceLineRef = useRef<any>(null)
  const prevPriceRef = useRef<number | null>(null)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const adjustingRef = useRef(false)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const [priceLineVersion, setPriceLineVersion] = useState(0)
  const [selection, setSelection] = useState<RangeSelection | null>(null)
  const [chartVersion, setChartVersion] = useState(0)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

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
  } = useDrawings(symbol, tf, chartRef, candleRef, containerRef, chartVersion)

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
      upColor: UP_COLOR, downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR, borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', priceLineVisible: false })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.9, bottom: 0 }, textColor: '#666666' })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries
    priceLineRef.current = candleSeries.createPriceLine({
      price: 0,
      color: '#26a65b',
      lineStyle: 2, // Dashed
      lineWidth: 1,
      axisLabelVisible: true,
      title: '',
    })
    setPriceLineVersion(v => v + 1)
    setChartVersion(v => v + 1)

    const ro = new ResizeObserver(() => {
      if (containerRef.current && !destroyedRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
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
      priceLineRef.current = null
      prevPriceRef.current = null
    }
  }, [symbol, tf, pricePrecision])

  const flush = useRafFlush(candleRef, volumeRef, destroyedRef)
  const { isInitialLoading, status } = useFullHistory(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, { limit: 1000 })
  useWsCandle(symbol, tf, flush, destroyedRef, candlesDataRef, adjustingRef)
  usePriceLine(symbol, tf, priceLineRef, prevPriceRef, destroyedRef, priceLineVersion, candlesDataRef)
  useWsTrade(symbol, tf, flush, destroyedRef, candlesDataRef, adjustingRef)
  useLazyScroll(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef, isInitialLoading, adjustingRef, setIsLoadingMore)

  // Set initial price line position from loaded data
  useEffect(() => {
    if (isInitialLoading || !priceLineRef.current) return
    const candles = candlesDataRef.current
    if (candles.length === 0) return
    const last = candles[candles.length - 1]
    if (isFinite(last.close) && last.close > 0) {
      const color = last.close >= last.open ? '#26a65b' : '#e74c3c'
      try {
        priceLineRef.current.applyOptions({ price: last.close, color })
        prevPriceRef.current = last.close
      } catch {}
    }
  }, [isInitialLoading, symbol, tf, priceLineVersion])

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

        const t1Raw = chart.timeScale().coordinateToTime(x1) as number | null
        const t2Raw = chart.timeScale().coordinateToTime(x2) as number | null

        if (t1Raw !== null && t2Raw !== null) {
          durationSec = Math.abs(t2Raw - t1Raw)
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
      <ExpandedChartHeader symbol={symbol} onBack={onBack} activeTool={activeTool} />
      <div ref={containerRef} className="relative flex-1 min-h-0">
        {isInitialLoading && <ChartCornerSpinner />}
        {!isInitialLoading && isLoadingMore && (
          <div className="absolute top-[8px] left-[8px] z-30 pointer-events-none">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-[4px] bg-[#1a1a1a]/95 border border-[#2a2a2a] shadow-lg">
              <div className="w-[12px] h-[12px] border-2 border-[#555] border-t-[#ccc] rounded-full animate-spin" />
              <span className="text-[11px] text-[#aaa] font-medium">Загрузка истории...</span>
            </div>
          </div>
        )}
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

export function ChartGrid() {
  const topSymbols = useCoinListStore(s => s.topChartSymbols)
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const expandChart = useCoinListStore(s => s.expandChart)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const [loadedSet, setLoadedSet] = useState<Set<string>>(() => new Set())

  useInitialCandlesPush()

  // Bulk prefetch: fetch all top symbols in one request instead of 9 individual
  useEffect(() => {
    if (topSymbols.length === 0) return
    getOrFetchBulk(topSymbols, tf, 300)
  }, [topSymbols, tf])

  useEffect(() => {
    setLoadedSet(new Set())
  }, [topSymbols, tf])

  const handleLoaded = useCallback((loadKey: string) => {
    setLoadedSet(prev => {
      if (prev.has(loadKey)) return prev
      const next = new Set(prev)
      next.add(loadKey)
      return next
    })
  }, [])

  if (expandedSymbol) {
    return <ExpandedChart symbol={expandedSymbol} onBack={() => expandChart(null)} />
  }

  const allChartsLoaded = topSymbols.length > 0 && topSymbols.every(symbol => loadedSet.has(`${tf}:${symbol}`))
  const showOverlay = !allChartsLoaded

  return (
    <div className="flex-1 h-full flex flex-col bg-[#0a0a0a]">
      <div className="relative flex-1 min-h-0 p-[2px] grid grid-cols-3 grid-rows-3 gap-[2px]">
        {topSymbols.map((symbol) => (
          <MiniChart key={`${tf}:${symbol}`} symbol={symbol} visible={allChartsLoaded} onLoaded={handleLoaded} />
        ))}
        {Array.from({ length: Math.max(0, 9 - topSymbols.length) }).map((_, idx) => (
          <div key={`placeholder-${idx}`} className="flex items-center justify-center bg-[#0e0e0e] border border-[#1f1f1f]" />
        ))}

        {showOverlay && (
          <div className="chart-loading-overlay absolute inset-0 z-30 flex items-center justify-center pointer-events-none backdrop-blur-[5px]">
            <span className="chart-loading-text text-[18px] font-semibold text-[#e8e8e8] tracking-wide">
              Графики загружаются<span className="chart-loading-dots" aria-hidden="true" />
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
