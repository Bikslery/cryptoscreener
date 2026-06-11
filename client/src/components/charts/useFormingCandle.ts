import { useEffect, useRef, useCallback } from 'react'
import type { ISeriesApi, Time } from 'lightweight-charts'
import { setLivePrice } from '../../store'
import { wsOnChannel, wsOnType, wsSubscribe, wsUnsubscribe } from '../../services/ws'
import * as candleCache from '../../services/candle-cache'
import type { Timeframe, UnifiedCandle, Exchange } from '../../types'
import { UP_COLOR, DOWN_COLOR, UP_COLOR_VOL, DOWN_COLOR_VOL } from './chart-colors'

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}

function getTfSeconds(tf: Timeframe): number {
  return TF_SECONDS[tf] || 60
}

function candleTimeFor(tf: Timeframe, timestampSec: number): number {
  const tfSec = getTfSeconds(tf)
  return Math.floor(timestampSec / tfSec) * tfSec
}

function volumeColor(close: number, open: number): string {
  return close >= open ? UP_COLOR_VOL() : DOWN_COLOR_VOL()
}

export interface FormingCandleControl {
  pause: () => void
  resume: () => void
}

export function useFormingCandle(
  symbol: string,
  exchange: Exchange | undefined,
  tf: Timeframe,
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  destroyedRef: React.RefObject<boolean>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  lastUpdateRef?: React.RefObject<number>,
): FormingCandleControl {
  const curRef = useRef<UnifiedCandle | null>(null)
  const pausedRef = useRef(false)
  const rafIdRef = useRef<number | null>(null)
  const pendingUpdateRef = useRef<{
    candle: { time: Time; open: number; high: number; low: number; close: number }
    volume: { time: Time; value: number; color: string }
  } | null>(null)
  const periodTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const channelUnsubRef = useRef<(() => void) | null>(null)
  const tradeUnsubRef = useRef<(() => void) | null>(null)

  const updateSeries = useCallback((c: UnifiedCandle) => {
    if (destroyedRef.current) return
    try {
      candleRef.current?.update({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })
      volumeRef.current?.update({
        time: c.time as Time,
        value: c.volume,
        color: volumeColor(c.close, c.open),
      })
      candleRef.current?.applyOptions({
        priceLineColor: c.close >= c.open ? UP_COLOR() : DOWN_COLOR(),
      })
    } catch {}
  }, [])

  const scheduleRaf = useCallback(() => {
    if (rafIdRef.current != null) return
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      if (destroyedRef.current || pausedRef.current) {
        pendingUpdateRef.current = null
        return
      }
      const p = pendingUpdateRef.current
      pendingUpdateRef.current = null
      if (!p) return
      try {
        candleRef.current?.update(p.candle)
        volumeRef.current?.update(p.volume)
        candleRef.current?.applyOptions({
          priceLineColor: p.candle.close >= p.candle.open ? UP_COLOR() : DOWN_COLOR(),
        })
      } catch {}
    })
  }, [])

  const queueRaf = useCallback((c: UnifiedCandle) => {
    if (destroyedRef.current || pausedRef.current) return
    pendingUpdateRef.current = {
      candle: { time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close },
      volume: { time: c.time as Time, value: c.volume, color: volumeColor(c.close, c.open) },
    }
    scheduleRaf()
  }, [])

  const writeToArray = useCallback((c: UnifiedCandle) => {
    const arr = candlesDataRef.current
    if (!arr) return
    const last = arr[arr.length - 1]
    if (last && last.time === c.time) {
      arr[arr.length - 1] = { ...c }
    } else if (!last || c.time > last.time) {
      arr.push({ ...c })
    }
  }, [])

  const closeCurrentCandle = useCallback(() => {
    const cur = curRef.current
    if (!cur) return
    writeToArray(cur)
    updateSeries(cur)
    curRef.current = null
  }, [])

  const startPeriodTimer = useCallback(() => {
    if (periodTimerRef.current) clearInterval(periodTimerRef.current)
    const tfSec = getTfSeconds(tf)
    const checkMs = Math.max(200, tfSec < 300 ? 500 : 1000)
    periodTimerRef.current = setInterval(() => {
      if (destroyedRef.current || pausedRef.current) return
      const cur = curRef.current
      if (!cur) return
      const now = Math.floor(Date.now() / 1000)
      const currentPeriod = candleTimeFor(tf, now)
      if (currentPeriod > cur.time) {
        closeCurrentCandle()
      }
    }, checkMs)
  }, [tf, closeCurrentCandle])

  const handleTrade = useCallback((trade: any) => {
    if (destroyedRef.current || pausedRef.current) return
    const price = typeof trade.price === 'number' ? trade.price : parseFloat(trade.price)
    if (!isFinite(price)) return

    if (lastUpdateRef) lastUpdateRef.current = Date.now()

    setLivePrice(symbol, price)

    const tradeSec = typeof trade.time === 'number' && isFinite(trade.time)
      ? trade.time
      : Math.floor(Date.now() / 1000)
    const ct = candleTimeFor(tf, tradeSec)
    let cur = curRef.current

    if (!cur || cur.time !== ct) {
      if (cur && cur.time < ct) {
        closeCurrentCandle()
      }
      const lastCandle = candlesDataRef.current?.[candlesDataRef.current.length - 1]
      cur = {
        symbol,
        exchange: exchange ?? lastCandle?.exchange ?? ('agg' as any),
        timeframe: tf,
        time: ct,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: trade.volume || 0,
        source: 'trade' as const,
      }
      curRef.current = cur
    } else {
      if (price > cur.high) cur.high = price
      if (price < cur.low) cur.low = price
      cur.close = price
      cur.volume += trade.volume || 0
    }

    queueRaf(curRef.current!)
  }, [symbol, tf, closeCurrentCandle, queueRaf])

  const handleCandle = useCallback((c: UnifiedCandle) => {
    if (destroyedRef.current || pausedRef.current) return
    if (!c || !isFinite(c.time)) return

    if (lastUpdateRef) lastUpdateRef.current = Date.now()

    const cur = curRef.current

    if (c.isFinal) {
      if (cur && cur.time === c.time) {
        curRef.current = null
      }
      const arr = candlesDataRef.current
      if (arr) {
        const last = arr[arr.length - 1]
        if (last && last.time === c.time) {
          arr[arr.length - 1] = { ...c }
        } else if (!last || c.time > last.time) {
          arr.push({ ...c })
        }
      }
      candleCache.updateCandle(exchange!, symbol, tf, { ...c, source: 'kline' })
      updateSeries(c)
      return
    }

    setLivePrice(symbol, c.close)

    const ct = c.time

    if (!cur || ct > cur.time) {
      if (cur && cur.time < ct) {
        closeCurrentCandle()
      }
      curRef.current = {
        symbol: c.symbol,
        exchange: c.exchange,
        timeframe: c.timeframe,
        time: ct,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        source: 'kline' as const,
      }
      queueRaf(curRef.current)
      return
    }

    if (ct === cur.time) {
      cur.open = c.open
      cur.close = c.close
      cur.volume = c.volume
      if (c.high > cur.high) cur.high = c.high
      if (c.low < cur.low) cur.low = c.low

      queueRaf(cur)
    }
  }, [symbol, tf, closeCurrentCandle, queueRaf, updateSeries])

  useEffect(() => {
    if (!exchange) return
    curRef.current = null
    pausedRef.current = false

    const candleChannel = `candle:${exchange}:${symbol}:${tf}`
    const tradeChannel = `trade:${exchange}:${symbol}`

    const unsubCandle = wsOnChannel(candleChannel, (msg) => {
      const c = msg.data as UnifiedCandle
      if (c) handleCandle(c)
    })
    wsSubscribe(candleChannel)

    const unsubTrade = wsOnType(tradeChannel, (msg) => {
      handleTrade(msg.data)
    })
    wsSubscribe(tradeChannel)

    startPeriodTimer()

    channelUnsubRef.current = () => {
      unsubCandle()
      wsUnsubscribe(candleChannel)
    }
    tradeUnsubRef.current = () => {
      unsubTrade()
      wsUnsubscribe(tradeChannel)
    }

    return () => {
      channelUnsubRef.current?.()
      tradeUnsubRef.current?.()
      channelUnsubRef.current = null
      tradeUnsubRef.current = null
      if (periodTimerRef.current) {
        clearInterval(periodTimerRef.current)
        periodTimerRef.current = null
      }
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      curRef.current = null
    }
  }, [symbol, exchange, tf, handleCandle, handleTrade, startPeriodTimer])

  const pause = useCallback(() => { pausedRef.current = true }, [])
  const resume = useCallback(() => {
    pausedRef.current = false
    const cur = curRef.current
    if (cur) updateSeries(cur)
  }, [updateSeries])

  return { pause, resume }
}
