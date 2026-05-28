import { useEffect, useRef, memo, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore, useLivePrice } from '../../store'
import { useShallow } from 'zustand/shallow'
import { wsOnChannel, wsOnType, wsSubscribe, wsUnsubscribe, wsOnType as wsOnMsgType } from '../../services/ws'
import api from '../../services/api'
import type { Timeframe, UnifiedCandle } from '../../types'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { ArrowLeft } from 'lucide-react'
import * as candleCache from '../../services/candle-cache'
import { useDrawings, type DrawingTool } from './useDrawings'
import DrawingToolsPanel from './DrawingToolsPanel'

const UP_COLOR = '#26a65b'
const DOWN_COLOR = '#e74c3c'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}
function getTfSeconds(tf: Timeframe): number { return TF_SECONDS[tf] || 60 }

const BATCH_SIZE = 1000
const BACKFILL_CONCURRENCY = 5
const BACKFILL_DELAY_MS = 50
const LISTING_EPOCH_MS = 1262304000000 // 2010-01-01 — safe floor for any crypto

function exchangeBadge(ex: string): string {
  if (ex.includes('binance') && ex.includes('futures')) return 'BI-F'
  if (ex.includes('binance') && ex.includes('spot')) return 'BI-S'
  if (ex.includes('bybit')) return 'BY-F'
  if (ex.includes('okx') && ex.includes('futures')) return 'OK-F'
  if (ex.includes('okx') && ex.includes('spot')) return 'OK-S'
  return 'EX'
}

// Receive WS initial-candles push ONCE and store in client cache
let initialPushReceived = false

function useInitialCandlesPush() {
  useEffect(() => {
    if (initialPushReceived) return
    const unsub = wsOnMsgType('initial-candles', (msg) => {
      if (initialPushReceived) return
      initialPushReceived = true
      const data = msg.data as Record<string, UnifiedCandle[]> | undefined
      if (!data) return
      candleCache.storeBulk(data)
    })
    return unsub
  }, [])
}

function useCandles(
  symbol: string,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  limit = 300,
  candlesDataRef?: React.RefObject<UnifiedCandle[]>,
) {
  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || destroyedRef.current) return

    candleRef.current.setData([])
    volumeRef.current.setData([])
    if (candlesDataRef) candlesDataRef.current = []

    // Cache-first: if client cache has candles, render instantly
    const cached = candleCache.getCandles(symbol, tf)
    if (cached && cached.length > 0) {
      if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
      if (candlesDataRef) candlesDataRef.current = cached
      const slice = cached.slice(-limit)
      const candleData = slice.map(c => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
      const volumeData = slice.map(c => ({
        time: c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
      }))
      candleRef.current.setData(candleData)
      volumeRef.current.setData(volumeData)
      chartRef.current?.timeScale().fitContent()
      return  // Data loaded from cache — no REST request needed
    }

    // No cache — fetch from server (which also uses its cache)
    api.get(`/coins/${symbol}/candles`, { params: { tf, limit } })
      .then(res => {
        if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
        const candles = res.data as UnifiedCandle[]
        if (candlesDataRef) candlesDataRef.current = candles
        candleCache.setCandles(symbol, tf, candles)
        const candleData = candles.map(c => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
        const volumeData = candles.map(c => ({
          time: c.time as Time,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
        }))
        candleRef.current.setData(candleData)
        volumeRef.current.setData(volumeData)
        chartRef.current?.timeScale().fitContent()
      })
      .catch(() => {})
  }, [symbol, tf])
}

function useFullHistory(
  symbol: string,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
) {
  useEffect(() => {
    const cancelled = { value: false }
    const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

    const renderCandles = (candles: UnifiedCandle[], fitContent: boolean) => {
      if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
      candlesDataRef.current = candles
      const candleData = candles.map(c => ({
        time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
      }))
      const volumeData = candles.map(c => ({
        time: c.time as Time, value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
      }))
      try {
        candleRef.current.setData(candleData)
        volumeRef.current.setData(volumeData)
        if (fitContent) chartRef.current?.timeScale().fitContent()
      } catch {}
    }

    const run = async () => {
      candleRef.current?.setData([])
      volumeRef.current?.setData([])
      candlesDataRef.current = []

      let candles: UnifiedCandle[] | undefined = candleCache.getCandles(symbol, tf)
      if (!candles || candles.length === 0) {
        try {
          const res = await api.get(`/coins/${symbol}/candles`, { params: { tf, limit: 1500 } })
          if (cancelled.value || destroyedRef.current) return
          candles = res.data as UnifiedCandle[]
          if (candles.length > 0) candleCache.setCandles(symbol, tf, candles)
        } catch {
          return
        }
      }
      if (!candles || candles.length === 0) return
      if (cancelled.value || destroyedRef.current) return

      renderCandles(candles, true)

      const tfMs = (TF_SECONDS[tf] || 60) * 1000
      const oldestTimeMs = candles[0].time * 1000
      const batchSpanMs = BATCH_SIZE * tfMs

      const batches: { startMs: number; endMs: number }[] = []
      for (let endMs = oldestTimeMs; endMs > LISTING_EPOCH_MS; endMs -= batchSpanMs) {
        const startMs = endMs - batchSpanMs
        batches.push({ startMs: Math.max(startMs, LISTING_EPOCH_MS), endMs })
      }
      if (batches.length === 0) return

      for (let i = 0; i < batches.length; i += BACKFILL_CONCURRENCY) {
        if (cancelled.value || destroyedRef.current) return
        const chunk = batches.slice(i, i + BACKFILL_CONCURRENCY)
        const results = await Promise.all(
          chunk.map(async (b) => {
            try {
              const res = await api.get(`/coins/${symbol}/candles`, {
                params: { tf, limit: BATCH_SIZE, startTime: b.startMs, endTime: b.endMs },
              })
              return res.data as UnifiedCandle[]
            } catch {
              return []
            }
          })
        )

        if (cancelled.value || destroyedRef.current) return

        let anyEmpty = false
        for (const batchCandles of results) {
          if (batchCandles.length === 0) { anyEmpty = true; continue }
          candleCache.prependCandles(symbol, tf, batchCandles)
        }

        const cached = candleCache.getCandles(symbol, tf)
        if (cached && cached.length > 0) {
          renderCandles(cached, false)
        }

        if (anyEmpty) return
        if (i + BACKFILL_CONCURRENCY < batches.length) {
          await delay(BACKFILL_DELAY_MS)
        }
      }
    }

    run()

    return () => {
      cancelled.value = true
    }
  }, [symbol, tf])
}

// RAF-throttled candle/volume updates: only the latest pending payload per frame
// is flushed to lightweight-charts. Avoids saturating React/main thread when
// WS bursts at 50–100 msg/s.
function useRafFlush(
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  destroyedRef: React.RefObject<boolean>,
) {
  const pendingCandle = useRef<{ time: Time; open: number; high: number; low: number; close: number } | null>(null)
  const pendingVolume = useRef<{ time: Time; value: number; color: string } | null>(null)
  const rafId = useRef<number | null>(null)

  const flush = () => {
    rafId.current = null
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
      pendingCandle.current = p
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
) {
  useEffect(() => {
    const channel = `candle:${symbol}:${tf}`
    const unsub = wsOnChannel(channel, (msg) => {
      if (destroyedRef.current) return
      const c = msg.data as UnifiedCandle
      if (!c) return
      // Update client cache
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
) {
  useEffect(() => {
    const tradeType = `trade:${symbol}`
    let cur: { time: number; open: number; high: number; low: number; close: number; volume: number } | null = null

    const unsub = wsOnType(tradeType, (msg) => {
      if (destroyedRef.current) return
      const trade = msg.data as any
      if (!trade?.price) return
      const price = typeof trade.price === 'number' ? trade.price : parseFloat(trade.price)
      if (!isFinite(price)) return
      const now = Math.floor(Date.now() / 1000)
      const tfSeconds = getTfSeconds(tf)
      const candleTime = Math.floor(now / tfSeconds) * tfSeconds

      if (!cur || cur.time !== candleTime) {
        cur = { time: candleTime, open: price, high: price, low: price, close: price, volume: trade.volume || 0 }
      } else {
        if (price > cur.high) cur.high = price
        if (price < cur.low) cur.low = price
        cur.close = price
        cur.volume += trade.volume || 0
      }

      flush.queueCandle({
        time: cur.time as Time,
        open: cur.open,
        high: cur.high,
        low: cur.low,
        close: cur.close,
      })
    })
    wsSubscribe(tradeType)

    return () => {
      unsub()
      wsUnsubscribe(tradeType)
    }
  }, [symbol, tf])
}

// Header is split out so price/flash updates never re-render the chart body.
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
        <span className="font-bold text-[11px] text-[#e0e0e0] truncate" style={{ fontFamily: "'Inter', sans-serif" }}>
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

// Animation: chart appears with a fade + subtle scale
const MiniChart = memo(function MiniChart({ symbol, animate }: { symbol: string; animate: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const [loaded, setLoaded] = useState(false)

  // Mark loaded once candles are rendered (via useCandles cache hit or REST response)
  // We detect this by checking if data was set on the series
  useEffect(() => {
    if (!animate) { setLoaded(true); return }
    // Small delay to let the chart render its data, then trigger animation
    const t = setTimeout(() => setLoaded(true), 30)
    return () => clearTimeout(t)
  }, [symbol, tf, animate])

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0e0e0e' }, textColor: '#666666', fontSize: 9, fontFamily: "'Inter', sans-serif" },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { visible: true, color: '#4d4d4d' }, horzLine: { visible: true, color: '#4d4d4d' } },
      rightPriceScale: { borderColor: '#1f1f1f', scaleMargins: { top: 0.1, bottom: 0.25 }, textColor: '#666666' },
      timeScale: { borderColor: '#1f1f1f', timeVisible: true, visible: true, textColor: '#666666', barSpacing: 6 },
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
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, textColor: '#666666' })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries

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
    }
  }, [symbol, tf, pricePrecision])

  const flush = useRafFlush(candleRef, volumeRef, destroyedRef)
  useCandles(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, 300)
  useWsCandle(symbol, tf, flush, destroyedRef)
  useWsTrade(symbol, tf, flush, destroyedRef)

  return (
    <div
      className={`relative flex flex-col h-full bg-[#0e0e0e] border border-[#1f1f1f] overflow-hidden rounded-[3px] transition-all duration-500 ease-out ${
        animate
          ? loaded
            ? 'opacity-100 scale-100'
            : 'opacity-0 scale-95'
          : 'opacity-100 scale-100'
      }`}
    >
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 select-none">
        <span className="text-[48px] font-bold text-white/[0.04] tracking-tighter uppercase" style={{ fontFamily: "'Inter', sans-serif" }}>
          {extractBaseAsset(symbol)}
        </span>
      </div>
      <MiniChartHeader symbol={symbol} />
      <div ref={containerRef} className="relative z-0 flex-1 min-h-0" />
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

// Header is split so live price ticks don't re-render the chart canvas.
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
        <span className="font-bold text-[14px] text-[#f0f0f0] tracking-tight" style={{ fontFamily: "'Inter', sans-serif" }}>
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

function ExpandedChart({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const [selection, setSelection] = useState<RangeSelection | null>(null)
  const [chartVersion, setChartVersion] = useState(0)

  const {
    drawings,
    activeTool,
    setActiveTool,
    clearAllDrawings,
    hasDrawings,
    deactivateTool,
    handleClick: drawingClickHandler,
    handleMouseMove: drawingMouseMoveHandler,
    pendingPoint,
    pendingPointPixel,
    previewLine,
    renderedDrawings,
    CLICK_THRESHOLD,
  } = useDrawings(symbol, tf, chartRef, candleRef, containerRef, chartVersion)

  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0e0e0e' }, textColor: '#b3b3b3', fontSize: 11, fontFamily: "'Inter', sans-serif" },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' }, horzLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' } },
      rightPriceScale: { borderColor: '#1f1f1f', scaleMargins: { top: 0.05, bottom: 0.15 }, textColor: '#666666' },
      timeScale: { borderColor: '#1f1f1f', timeVisible: true, visible: true, textColor: '#666666', barSpacing: 6 },
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
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.9, bottom: 0 }, textColor: '#666666' })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries
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
    }
  }, [symbol, tf, pricePrecision])

  const flush = useRafFlush(candleRef, volumeRef, destroyedRef)
  useFullHistory(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, candlesDataRef)
  useWsCandle(symbol, tf, flush, destroyedRef, candlesDataRef)
  useWsTrade(symbol, tf, flush, destroyedRef)

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
    const onContextMenu = (e: MouseEvent) => e.preventDefault()

    container.addEventListener('mousedown', onMouseDown, true)
    container.addEventListener('auxclick', onAuxclick)
    container.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      container.removeEventListener('mousedown', onMouseDown, true)
      container.removeEventListener('auxclick', onAuxclick)
      container.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      dragging = false
      if (mmRaf != null) cancelAnimationFrame(mmRaf)
    }
  }, [symbol, tf, activeTool, drawingClickHandler, drawingMouseMoveHandler, deactivateTool])

  const precision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      setSvgSize({ w: container.clientWidth, h: container.clientHeight })
    })
    ro.observe(container)
    setSvgSize({ w: container.clientWidth, h: container.clientHeight })
    return () => ro.disconnect()
  }, [symbol, tf])

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0e0e0e]">
      <ExpandedChartHeader symbol={symbol} onBack={onBack} activeTool={activeTool} />
      <div ref={containerRef} className="relative flex-1 min-h-0">
        {/* SVG overlay for drawings */}
        <svg
          className="pointer-events-none absolute inset-0 z-20"
          width={svgSize.w}
          height={svgSize.h}
          style={{ overflow: 'visible' }}
        >
          {renderedDrawings.map(rd => (
            <g key={rd.id}>{rd.elements}</g>
          ))}
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

        {/* Drawing tools panel */}
        <DrawingToolsPanel
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          clearAllDrawings={clearAllDrawings}
          hasDrawings={hasDrawings}
          pendingPoint={pendingPoint}
        />

        {/* Measure tool overlay */}
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
  const [visibleCount, setVisibleCount] = useState(0)
  const mountedRef = useRef(false)

  // Listen for WS initial-candles push
  useInitialCandlesPush()

  // All 9 charts mount simultaneously — no stagger
  useEffect(() => {
    if (topSymbols.length === 0) return
    setVisibleCount(topSymbols.length)
  }, [topSymbols])

  if (expandedSymbol) {
    return <ExpandedChart symbol={expandedSymbol} onBack={() => expandChart(null)} />
  }

  if (topSymbols.length === 0) {
    return (
      <div className="flex-1 h-full flex flex-col bg-[#0a0a0a]">
        <div className="flex-1 p-[2px] grid grid-cols-3 grid-rows-3 gap-[2px]">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="flex items-center justify-center bg-[#0e0e0e] border border-[#1f1f1f] text-[#333] text-[11px]">
              Loading...
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 h-full flex flex-col bg-[#0a0a0a]">
      <div className="flex-1 min-h-0 p-[2px] grid grid-cols-3 grid-rows-3 gap-[2px]">
        {topSymbols.slice(0, visibleCount).map((symbol, i) => (
          <MiniChart key={symbol} symbol={symbol} animate={true} />
        ))}
        {Array.from({ length: Math.max(0, 9 - visibleCount) }).map((_, i) => (
          <div key={`placeholder-${i}`} className="flex items-center justify-center bg-[#0e0e0e] border border-[#1f1f1f] text-[#333] text-[11px]">
            Loading...
          </div>
        ))}
      </div>
    </div>
  )
}
