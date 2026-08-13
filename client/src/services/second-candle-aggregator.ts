import type { UnifiedCandle, Exchange } from '../types'

/**
 * Client-side second-candle aggregator (scalpboard.io `processTradeForSeconds`
 * parity).
 *
 * Scalpboard builds 1s/5s/15s candles on the client from the aggTrade lane:
 * each print is bucketed into `floor(timeSec / interval) * interval` (UTC),
 * OHLCV accumulates in-place, and the current bar is flushed on a 50ms timer.
 * Second-candle timeframes never round-trip through the server kline lane —
 * the server cannot serve 1s klines for futures/bybit, so the client becomes
 * the candle source.
 *
 * Rules (mirror scalpboard exactly):
 *  - bucket start = `floor(timeSec / tfSec) * tfSec` on RAW UTC seconds —
 *    the chart paint shift (toChartTime) is applied by the caller later.
 *  - first print of a bucket opens the bar (open = high = low = close).
 *  - trade prints accumulate volume; the bookTicker mid (`addMid`) never
 *    touches volume.
 *  - a bucket switch pushes the previous bar out IMMEDIATELY (it would
 *    otherwise be lost between flushes).
 *  - the current bar is flushed every 50ms, but only when it actually
 *    changed since the last flush (dedupe — no-op bars are not repainted).
 *  - `reset()` clears the open bar on WS reconnect: a dead-window bucket must
 *    not survive a fresh socket, and the next print re-opens cleanly.
 */
const FLUSH_MS = 50

export interface SecondCandleAggregatorOpts {
  symbol: string
  exchange: Exchange
  tf: string
  tfSeconds: number
  onCandle: (candle: UnifiedCandle) => void
}

export interface SecondCandleAggregator {
  addTrade(price: number, volume: number, timeSec: number): void
  addMid(price: number, timeSec: number): void
  reset(): void
  destroy(): void
}

export function createSecondCandleAggregator(opts: SecondCandleAggregatorOpts): SecondCandleAggregator {
  const { symbol, exchange, tf, tfSeconds, onCandle } = opts

  let current: UnifiedCandle | null = null
  let dirty = false
  let destroyed = false
  let lastMidPrice = 0
  let flushTimer: ReturnType<typeof setInterval> | null = null

  function open(price: number, timeSec: number, volume: number) {
    const bucket = Math.floor(timeSec / tfSeconds) * tfSeconds
    current = {
      symbol,
      exchange,
      timeframe: tf,
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
    }
    dirty = true
  }

  function flushNow() {
    if (!current || !dirty) return
    onCandle({ ...current })
    dirty = false
  }

  function add(price: number, volume: number, timeSec: number, isMid: boolean) {
    if (destroyed) return
    if (!isFinite(price) || price <= 0) return
    if (!isFinite(timeSec) || timeSec <= 0) return

    const bucket = Math.floor(timeSec / tfSeconds) * tfSeconds

    if (!current || bucket !== current.time) {
      // Bucket switch: the previous bar must not be lost between flushes.
      if (current) flushNow()
      open(price, timeSec, isMid ? 0 : volume)
      if (isMid) lastMidPrice = price
      return
    }

    // Dedupe only applies to the mid lane: identical consecutive mid prints
    // add nothing, but identical trade prints still carry volume.
    if (isMid && price === lastMidPrice) return
    if (isMid) lastMidPrice = price

    current.high = Math.max(current.high, price)
    current.low = Math.min(current.low, price)
    current.close = price
    if (!isMid) current.volume += volume
    dirty = true
  }

  flushTimer = setInterval(() => {
    if (destroyed) return
    flushNow()
  }, FLUSH_MS)

  return {
    addTrade(price: number, volume: number, timeSec: number) {
      add(price, volume, timeSec, false)
    },
    addMid(price: number, timeSec: number) {
      add(price, 0, timeSec, true)
    },
    reset() {
      current = null
      dirty = false
      lastMidPrice = 0
    },
    destroy() {
      destroyed = true
      if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      current = null
    },
  }
}
