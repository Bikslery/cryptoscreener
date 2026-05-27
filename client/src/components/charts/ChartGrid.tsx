import { useEffect, useRef, memo, useState } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore, useLivePrice } from '../../store'
import { useShallow } from 'zustand/shallow'
import { wsOnChannel, wsOnType, wsSubscribe, wsUnsubscribe } from '../../services/ws'
import api from '../../services/api'
import * as candleCache from '../../services/candle-cache'
import type { Timeframe, UnifiedCandle } from '../../types'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { ArrowLeft } from 'lucide-react'

const UP_COLOR = '#26a65b'
const DOWN_COLOR = '#e74c3c'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
}
function getTfSeconds(tf: Timeframe): number { return TF_SECONDS[tf] || 60 }

function exchangeBadge(ex: string): string {
  if (ex.includes('binance') && ex.includes('futures')) return 'BI-F'
  if (ex.includes('binance') && ex.includes('spot')) return 'BI-S'
  if (ex.includes('bybit')) return 'BY-F'
  if (ex.includes('okx') && ex.includes('futures')) return 'OK-F'
  if (ex.includes('okx') && ex.includes('spot')) return 'OK-S'
  return 'EX'
}

// --- WS initial-candles push handler ---

export function useInitialCandlesPush() {
  useEffect(() => {
    // Listen for initial-candles WS message
    // Server format: { type: 'initial-candles', data: { 'BTCUSDT:5m': [...], 'ETHUSDT:1m': [...] } }
    const unsub = wsOnType('initial-candles', (msg) => {
      const data = msg.data as Record<string, UnifiedCandle[]> | null
      if (!data) return

      // Store each key in cache
      for (const [key, candles] of Object.entries(data)) {
        if (candles.length === 0) continue
        const colonIdx = key.lastIndexOf(':')
        if (colonIdx === -1) continue
        const symbol = key.slice(0, colonIdx)
        const tf = key.slice(colonIdx + 1)
        candleCache.setCandles(symbol, tf, candles)
      }
    })
    return unsub
  }, [])
}

// --- RAF-throttled candle/volume updates ---
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

// --- Apply candles to chart series ---
function applyCandlesToChart(
  candles: UnifiedCandle[],
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  chartRef: React.RefObject<IChartApi | null>,
  destroyedRef: React.RefObject<boolean>,
) {
  if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
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
}

// --- WS candle subscription ---
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
      candleCache.updateCandle(c)

      // Update local ref
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

// --- WS trade subscription ---
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

// --- MiniChart Header ---
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

// --- MiniChart ---
const MiniChart = memo(function MiniChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const pricePrecision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)
  const [loaded, setLoaded] = useState(false)

  // Create chart instance
  useEffect(() => {
    destroyedRef.current = false
    setLoaded(false)
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0e0e0e' }, textColor: '#666666', fontSize: 9, fontFamily: "'Inter', sans-serif" },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { visible: true, color: '#4d4d4d' }, horzLine: { visible: true, color: '#4d4d4d' } },
      rightPriceScale: { borderColor: '#1f1f1f', scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: '#1f1f1f', timeVisible: true, visible: true, barSpacing: 6, minBarSpacing: 2 },
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
      borderVisible: true,
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })

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
        const newSpacing = Math.max(2, Math.min(30, currentSpacing + delta))
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

  // Load candles — from cache first, then REST if needed
  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || destroyedRef.current) return

    // Check client cache first
    const cached = candleCache.getCandles(symbol, tf)
    if (cached && cached.length > 0) {
      applyCandlesToChart(cached, candleRef, volumeRef, chartRef, destroyedRef)
      setLoaded(true)
      return
    }

    // No cache — fetch from REST
    api.get(`/coins/${symbol}/candles`, { params: { tf, limit: 300 } })
      .then(res => {
        if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
        const candles = res.data as UnifiedCandle[]
        if (candles.length > 0) {
          candleCache.setCandles(symbol, tf, candles)
        }
        applyCandlesToChart(candles, candleRef, volumeRef, chartRef, destroyedRef)
        setLoaded(true)
      })
      .catch(() => {})
  }, [symbol, tf])

  useWsCandle(symbol, tf, flush, destroyedRef)
  useWsTrade(symbol, tf, flush, destroyedRef)

  return (
    <div className="relative flex flex-col h-full bg-[#0e0e0e] border border-[#1f1f1f] overflow-hidden rounded-[3px]">
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 select-none">
        <span className="text-[48px] font-bold text-white/[0.04] tracking-tighter uppercase" style={{ fontFamily: "'Inter', sans-serif" }}>
          {extractBaseAsset(symbol)}
        </span>
      </div>
      {!loaded && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#0e0e0e]/95 gap-2 chart-loading-overlay pointer-events-none">
          <div className="flex items-center gap-[4px]">
            <div className="w-[24px] h-[3px] rounded-[1px] bg-[#333] chart-skeleton-bar" />
            <div className="w-[16px] h-[3px] rounded-[1px] bg-[#2a2a2a] chart-skeleton-bar" style={{ animationDelay: '0.15s' }} />
            <div className="w-[20px] h-[3px] rounded-[1px] bg-[#333] chart-skeleton-bar" style={{ animationDelay: '0.3s' }} />
          </div>
          <span className="text-[10px] text-[#555] tracking-wide" style={{ fontFamily: "'Inter', sans-serif" }}>
            Загрузка...
          </span>
        </div>
      )}
      <MiniChartHeader symbol={symbol} />
      <div ref={containerRef} className="relative z-0 flex-1 min-h-0" />
    </div>
  )
})

// --- Range Selection ---
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

// --- Expanded Chart Header ---
const ExpandedChartHeader = memo(function ExpandedChartHeader({ symbol, onBack }: { symbol: string; onBack: () => void }) {
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

      <div className="ml-auto text-[10px] text-[#666] font-mono">
        Shift + ЛКМ / Колёсико — измерить %
      </div>
    </div>
  )
})

// --- Expanded Chart ---
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

  // Create chart instance
  useEffect(() => {
    destroyedRef.current = false
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0e0e0e' }, textColor: '#b3b3b3', fontSize: 11, fontFamily: "'Inter', sans-serif" },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' }, horzLine: { color: '#4d4d4d', labelBackgroundColor: '#4d4d4d' } },
      rightPriceScale: { borderColor: '#1f1f1f', scaleMargins: { top: 0.05, bottom: 0.15 } },
      timeScale: { borderColor: '#1f1f1f', timeVisible: true, visible: true, barSpacing: 6, minBarSpacing: 2 },
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
      borderVisible: true,
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: Math.pow(10, -pricePrecision),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.9, bottom: 0 } })

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
        const newSpacing = Math.max(2, Math.min(30, currentSpacing + delta))
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

  // Load candles — cache first, then REST
  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || destroyedRef.current) return

    // Check client cache first
    const cached = candleCache.getCandles(symbol, tf)
    if (cached && cached.length > 0) {
      candlesDataRef.current = cached
      applyCandlesToChart(cached, candleRef, volumeRef, chartRef, destroyedRef)
    }

    // Always fetch more data for expanded chart (500 candles)
    api.get(`/coins/${symbol}/candles`, { params: { tf, limit: 500 } })
      .then(res => {
        if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
        const candles = res.data as UnifiedCandle[]
        if (candles.length > 0) {
          // Merge with cache — REST data takes priority
          candleCache.setCandles(symbol, tf, candles)
          candlesDataRef.current = candles
        }
        applyCandlesToChart(candles.length > 0 ? candles : (cached || []), candleRef, volumeRef, chartRef, destroyedRef)
      })
      .catch(() => {})
  }, [symbol, tf])

  useWsCandle(symbol, tf, flush, destroyedRef, candlesDataRef)
  useWsTrade(symbol, tf, flush, destroyedRef)

  useEffect(() => {
    setSelection(null)
  }, [symbol, tf])

  // --- Range selection via Shift+click or middle mouse ---
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let dragging = false
    let startX = 0
    let startY = 0
    let restoreOpts: { handleScroll?: boolean; handleScale?: boolean } | null = null

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

      return { startX, startY, endX: curX, endY: curY, startPrice, endPrice, changePct, durationSec, valid }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (!(e.button === 0 && e.shiftKey) && e.button !== 1) return
      const rect = container.getBoundingClientRect()
      startX = e.clientX - rect.left
      startY = e.clientY - rect.top
      dragging = true
      e.preventDefault()
      e.stopPropagation()
      const chart = chartRef.current
      if (chart) {
        restoreOpts = { handleScroll: true, handleScale: true }
        chart.applyOptions({ handleScroll: false, handleScale: false })
      }
      setSelection(computeSelection(startX, startY))
    }

    let mmRaf: number | null = null
    let mmX = 0, mmY = 0
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const rect = container.getBoundingClientRect()
      mmX = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      mmY = Math.max(0, Math.min(e.clientY - rect.top, rect.height))
      if (mmRaf != null) return
      mmRaf = requestAnimationFrame(() => {
        mmRaf = null
        if (!dragging) return
        setSelection(computeSelection(mmX, mmY))
      })
    }

    const finishDrag = () => {
      if (!dragging) return
      dragging = false
      if (mmRaf != null) { cancelAnimationFrame(mmRaf); mmRaf = null }
      const chart = chartRef.current
      if (chart && restoreOpts) {
        chart.applyOptions(restoreOpts)
      }
      restoreOpts = null
    }

    const onMouseUp = () => {
      finishDrag()
      setSelection(null)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null)
        finishDrag()
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
      finishDrag()
    }
  }, [symbol, tf])

  const precision = useCoinListStore(s => s.coinMap.get(symbol)?.pricePrecision ?? 2)

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0e0e0e]">
      <ExpandedChartHeader symbol={symbol} onBack={onBack} />
      <div ref={containerRef} className="relative flex-1 min-h-0">
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

// --- Chart Grid with bulk init ---
export function ChartGrid() {
  const topSymbols = useCoinListStore(s => s.topChartSymbols)
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const expandChart = useCoinListStore(s => s.expandChart)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const bulkLoadedRef = useRef(false)
  const bulkLoadingRef = useRef(false)

  // WS initial push handler
  useInitialCandlesPush()

  // Bulk load candles for all top-9 symbols via /candles-bulk
  useEffect(() => {
    if (topSymbols.length === 0 || bulkLoadingRef.current) return

    // If we already have data in cache for most symbols, skip bulk
    const cachedCount = topSymbols.filter(s => candleCache.hasCandles(s, tf)).length
    if (cachedCount >= topSymbols.length - 2 && !bulkLoadedRef.current) {
      bulkLoadedRef.current = true
      return
    }

    if (bulkLoadedRef.current) return

    bulkLoadingRef.current = true
    api.post('/coins/candles-bulk', { symbols: topSymbols, tf, limit: 300 })
      .then(res => {
        const data = res.data as Record<string, UnifiedCandle[]>
        if (data) {
          candleCache.storeBulk(data, tf)
        }
        bulkLoadedRef.current = true
        bulkLoadingRef.current = false
      })
      .catch(() => {
        bulkLoadingRef.current = false
      })
  }, [topSymbols, tf])

  // Reset bulk flag when top symbols change significantly
  useEffect(() => {
    bulkLoadedRef.current = false
    bulkLoadingRef.current = false
  }, [topSymbols.join(',')])

  if (expandedSymbol) {
    return <ExpandedChart symbol={expandedSymbol} onBack={() => expandChart(null)} />
  }

  if (topSymbols.length === 0) {
    return (
      <div className="flex-1 h-full flex flex-col bg-[#0a0a0a]">
        <div className="flex-1 p-[2px] grid grid-cols-3 grid-rows-3 gap-[2px]">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center justify-center bg-[#0e0e0e] border border-[#1f1f1f] gap-2 chart-loading-overlay">
              <div className="flex items-center gap-[4px]">
                <div className="w-[24px] h-[3px] rounded-[1px] bg-[#333] chart-skeleton-bar" />
                <div className="w-[16px] h-[3px] rounded-[1px] bg-[#2a2a2a] chart-skeleton-bar" style={{ animationDelay: '0.15s' }} />
                <div className="w-[20px] h-[3px] rounded-[1px] bg-[#333] chart-skeleton-bar" style={{ animationDelay: '0.3s' }} />
              </div>
              <span className="text-[10px] text-[#555] tracking-wide" style={{ fontFamily: "'Inter', sans-serif" }}>
                Загрузка...
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // No stagger — all 9 charts mount simultaneously
  return (
    <div className="flex-1 h-full flex flex-col bg-[#0a0a0a]">
      <div className="flex-1 min-h-0 p-[2px] grid grid-cols-3 grid-rows-3 gap-[2px]">
        {topSymbols.slice(0, 9).map(symbol => (
          <MiniChart key={symbol} symbol={symbol} />
        ))}
      </div>
    </div>
  )
}
