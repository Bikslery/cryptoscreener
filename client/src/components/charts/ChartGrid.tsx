import { useEffect, useRef, memo, useState } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { useCoinListStore } from '../../store'
import { wsOnMessage, wsSubscribe, wsUnsubscribe } from '../../services/ws'
import api from '../../services/api'
import type { Timeframe, UnifiedCandle } from '../../types'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { ArrowLeft } from 'lucide-react'

const UP_COLOR = '#26a65b'
const DOWN_COLOR = '#e74c3c'

function exchangeBadge(ex: string): string {
  if (ex.includes('binance') && ex.includes('futures')) return 'BI-F'
  if (ex.includes('binance') && ex.includes('spot')) return 'BI-S'
  if (ex.includes('bybit')) return 'BY-F'
  if (ex.includes('okx') && ex.includes('futures')) return 'OK-F'
  if (ex.includes('okx') && ex.includes('spot')) return 'OK-S'
  return 'EX'
}

function useCandles(symbol: string, tf: Timeframe, candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>, volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>, chartRef: React.RefObject<IChartApi | null>, destroyedRef: React.RefObject<boolean>, limit = 300, candlesDataRef?: React.RefObject<UnifiedCandle[]>) {
  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || destroyedRef.current) return

    candleRef.current.setData([])
    volumeRef.current.setData([])
    if (candlesDataRef) candlesDataRef.current = []

    api.get(`/coins/${symbol}/candles`, { params: { tf, limit } })
      .then(res => {
        if (destroyedRef.current || !candleRef.current || !volumeRef.current) return
        const candles = res.data as UnifiedCandle[]
        if (candlesDataRef) candlesDataRef.current = candles
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

function useWsCandle(symbol: string, tf: Timeframe, candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>, volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>, destroyedRef: React.RefObject<boolean>, candlesDataRef?: React.RefObject<UnifiedCandle[]>) {
  const wsUnsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (wsUnsubRef.current) {
      wsUnsubRef.current()
      wsUnsubRef.current = null
    }

    const unsub = wsOnMessage((msg) => {
      if (destroyedRef.current) return
      if (msg.type === 'candle' && msg.channel === `candle:${symbol}:${tf}`) {
        const c = msg.data as UnifiedCandle
        if (!candleRef.current || !volumeRef.current) return
        if (candlesDataRef && candlesDataRef.current) {
          const arr = candlesDataRef.current
          const last = arr[arr.length - 1]
          if (last && last.time === c.time) {
            arr[arr.length - 1] = c
          } else if (!last || c.time > last.time) {
            arr.push(c)
          }
        }
        try {
          candleRef.current.update({
            time: c.time as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })
          volumeRef.current.update({
            time: c.time as Time,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(38,166,91,0.27)' : 'rgba(231,76,60,0.27)',
          })
        } catch {}
      }
    })
    wsSubscribe(`candle:${symbol}:${tf}`)
    wsUnsubRef.current = unsub

    return () => {
      if (wsUnsubRef.current) {
        wsUnsubRef.current()
        wsUnsubRef.current = null
      }
      wsUnsubscribe(`candle:${symbol}:${tf}`)
    }
  }, [symbol, tf])
}

function useWsTrade(symbol: string, tf: Timeframe, candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>, volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>, destroyedRef: React.RefObject<boolean>) {
  const currentCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number; volume: number } | null>(null)

  useEffect(() => {
    currentCandleRef.current = null

    const unsub = wsOnMessage((msg) => {
      if (destroyedRef.current) return
      if (msg.type === `trade:${symbol}`) {
        const trade = msg.data as any
        if (!candleRef.current || !volumeRef.current || !trade?.price) return

        try {
          const price = parseFloat(trade.price)
          const now = Math.floor(Date.now() / 1000)

          // Align time to timeframe interval
          const tfSeconds = getTfSeconds(tf)
          const candleTime = Math.floor(now / tfSeconds) * tfSeconds

          let candle = currentCandleRef.current
          if (!candle || candle.time !== candleTime) {
            // New candle started
            candle = {
              time: candleTime,
              open: price,
              high: price,
              low: price,
              close: price,
              volume: trade.volume || 0,
            }
            currentCandleRef.current = candle
          } else {
            // Update existing candle
            candle.high = Math.max(candle.high, price)
            candle.low = Math.min(candle.low, price)
            candle.close = price
            candle.volume += trade.volume || 0
          }

          candleRef.current.update({
            time: candle.time as Time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          })
        } catch {}
      }
    })
    wsSubscribe(`trade:${symbol}`)

    return () => {
      unsub()
      wsUnsubscribe(`trade:${symbol}`)
    }
  }, [symbol, tf])
}

function getTfSeconds(tf: Timeframe): number {
  const map: Record<string, number> = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800,
  }
  return map[tf] || 60
}

const MiniChart = memo(function MiniChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const coin = useCoinListStore(s => s.sortedCoins.find(c => c.symbol === symbol))
  const isUp = coin ? coin.change24h >= 0 : true
  const [flash, setFlash] = useState<'green' | 'red' | null>(null)
  const prevPriceRef = useRef<number | null>(null)

  // Flash effect on price change
  useEffect(() => {
    if (!coin) return
    const currentPrice = coin.price
    const prevPrice = prevPriceRef.current
    if (prevPrice !== null && currentPrice !== prevPrice) {
      setFlash(currentPrice > prevPrice ? 'green' : 'red')
      const timer = setTimeout(() => setFlash(null), 300)
      return () => clearTimeout(timer)
    }
    prevPriceRef.current = currentPrice
  }, [coin?.price])

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
        precision: coin?.pricePrecision ?? 2,
        minMove: Math.pow(10, -(coin?.pricePrecision ?? 2)),
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

    // Ctrl + wheel changes bar spacing (candle width)
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
  }, [symbol, tf])

  useCandles(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, 300)
  useWsCandle(symbol, tf, candleRef, volumeRef, destroyedRef)
  useWsTrade(symbol, tf, candleRef, volumeRef, destroyedRef)

  const badge = exchangeBadge(coin?.exchange || '')
  const vol = coin ? formatCompact(coin.quoteVolume24h) : '-'
  const precision = coin?.pricePrecision ?? 2

  return (
    <div className="relative flex flex-col h-full bg-[#0e0e0e] border border-[#1f1f1f] overflow-hidden rounded-[3px]">
      {/* Водяной знак */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 select-none">
        <span className="text-[48px] font-bold text-white/[0.04] tracking-tighter uppercase" style={{ fontFamily: "'Inter', sans-serif" }}>
          {extractBaseAsset(symbol)}
        </span>
      </div>

      {/* Шапка */}
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

function ExpandedChart({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const candlesDataRef = useRef<UnifiedCandle[]>([])
  const tf = useCoinListStore(s => s.activeTimeframe)
  const destroyedRef = useRef(false)
  const coin = useCoinListStore(s => s.sortedCoins.find(c => c.symbol === symbol))
  const isUp = coin ? coin.change24h >= 0 : true
  const [selection, setSelection] = useState<RangeSelection | null>(null)

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
        precision: coin?.pricePrecision ?? 2,
        minMove: Math.pow(10, -(coin?.pricePrecision ?? 2)),
      },
    })
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.9, bottom: 0 }, textColor: '#666666' })

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries

    const ro = new ResizeObserver(() => {
      if (containerRef.current && !destroyedRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
      }
    })
    ro.observe(containerRef.current)

    // Ctrl + wheel changes bar spacing (candle width)
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
  }, [symbol, tf])

  useCandles(symbol, tf, candleRef, volumeRef, chartRef, destroyedRef, 500, candlesDataRef)
  useWsCandle(symbol, tf, candleRef, volumeRef, destroyedRef, candlesDataRef)
  useWsTrade(symbol, tf, candleRef, volumeRef, destroyedRef)

  useEffect(() => {
    setSelection(null)
  }, [symbol, tf])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let dragging = false
    let startX = 0
    let startY = 0
    let restoreOpts: { handleScroll?: boolean; handleScale?: boolean } | null = null

    const computeSelection = (curX: number, curY: number): RangeSelection => {
      const chart = chartRef.current
      const candles = candlesDataRef.current
      const x1 = Math.min(startX, curX)
      const x2 = Math.max(startX, curX)
      let startPrice = 0
      let endPrice = 0
      let changePct = 0
      let durationSec = 0
      let valid = false

      if (chart && candles.length > 0) {
        const t1Raw = chart.timeScale().coordinateToTime(x1) as number | null
        const t2Raw = chart.timeScale().coordinateToTime(x2) as number | null

        const sorted = candles
        const firstT = sorted[0].time
        const lastT = sorted[sorted.length - 1].time
        const tStart = (typeof t1Raw === 'number' ? t1Raw : firstT) as number
        const tEnd = (typeof t2Raw === 'number' ? t2Raw : lastT) as number

        const tLo = Math.min(tStart, tEnd)
        const tHi = Math.max(tStart, tEnd)

        const startCandle = sorted.find(c => c.time >= tLo) || sorted[0]
        let endCandle: UnifiedCandle | undefined
        for (let i = sorted.length - 1; i >= 0; i--) {
          if (sorted[i].time <= tHi) { endCandle = sorted[i]; break }
        }
        if (!endCandle) endCandle = sorted[sorted.length - 1]

        if (startCandle && endCandle && startCandle.open > 0) {
          startPrice = startCandle.open
          endPrice = endCandle.close
          changePct = ((endPrice - startPrice) / startPrice) * 100
          durationSec = Math.max(0, endCandle.time - startCandle.time)
          valid = true
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
      if (e.button !== 0 || !e.shiftKey) return
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

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setSelection(computeSelection(x, y))
    }

    const finishDrag = () => {
      if (!dragging) return
      dragging = false
      const chart = chartRef.current
      if (chart && restoreOpts) {
        chart.applyOptions(restoreOpts)
      }
      restoreOpts = null
    }

    const onMouseUp = () => finishDrag()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null)
        finishDrag()
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
      finishDrag()
    }
  }, [symbol, tf])

  const badge = exchangeBadge(coin?.exchange || '')
  const volDisplay = coin ? formatCompact(coin.quoteVolume24h) : '-'
  const precision = coin?.pricePrecision ?? 2

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0e0e0e]">
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

        <span className="font-mono font-bold text-[13px] text-[#e0e0e0]">{coin ? `$${formatPrice(coin.price, precision)}` : ''}</span>

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
          Shift + ЛКМ — измерить %
        </div>
      </div>
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

export function ChartGrid() {
  const topSymbols = useCoinListStore(s => s.topChartSymbols)
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const expandChart = useCoinListStore(s => s.expandChart)

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
        {topSymbols.map(symbol => (
          <MiniChart key={symbol} symbol={symbol} />
        ))}
      </div>
    </div>
  )
}
