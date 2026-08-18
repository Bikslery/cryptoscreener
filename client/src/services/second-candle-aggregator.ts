import type { UnifiedCandle, Exchange } from '../types'

/**
 * Client-side second-candle aggregator (scalpboard.io `processTradeForSeconds`
 * parity).
 *
 * Scalpboard builds 1s/5s/15s candles on the client from the aggTrade lane
 * ONLY — the chart's price lane is explicitly skipped for 1s/5s/15s, and the
 * server cannot serve second klines for futures/bybit. Each print is bucketed
 * into `floor(timeSec / interval) * interval` (UTC), OHLCV accumulates
 * in-place, and the current bar is flushed on a 50ms timer.
 *
 * Rules (mirror scalpboard exactly):
 *  - bucket start = `floor(timeSec / tfSec) * tfSec` on RAW UTC seconds —
 *    the chart paint shift (toChartTime) is applied by the caller later.
 *  - first print of a bucket opens the bar (open = high = low = close). A
 *    bucket NEVER re-opens: once open, only high/low/close/volume mutate, so
 *    the open is exactly the first real print — no quote contamination, no
 *    repaint with a different open.
 *  - prints accumulate base volume (consistent with our server-side candles;
 *    scalpboard accumulates quote volume — either is self-consistent).
 *  - a late print for an ALREADY-CLOSED bucket (bucket < current) is DROPPED:
 *    replaying it would roll the bar back and repaint a different open. The
 *    trade lane is ordered by the server, so this only guards reconnects.
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
  reset(): void
  destroy(): void
}

export function createSecondCandleAggregator(opts: SecondCandleAggregatorOpts): SecondCandleAggregator {
  const { symbol, exchange, tf, tfSeconds, onCandle } = opts

  let current: UnifiedCandle | null = null
  let dirty = false
  let destroyed = false
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

  function add(price: number, volume: number, timeSec: number) {
    if (destroyed) return
    if (!isFinite(price) || price <= 0) return
    if (!isFinite(timeSec) || timeSec <= 0) return

    const bucket = Math.floor(timeSec / tfSeconds) * tfSeconds

    if (current && bucket < current.time) {
      // Late print for an already-closed bucket: the previous bar was already
      // flushed/painted, and re-opening it would roll the series back and
      // repaint the open. Drop.
      return
    }

    if (!current || bucket > current.time) {
      // Bucket switch: the previous bar must not be lost between flushes.
      if (current) flushNow()
      open(price, timeSec, volume)
      return
    }

    current.high = Math.max(current.high, price)
    current.low = Math.min(current.low, price)
    current.close = price
    current.volume += volume
    dirty = true
  }

  flushTimer = setInterval(() => {
    if (destroyed) return
    flushNow()
  }, FLUSH_MS)

  return {
    addTrade(price: number, volume: number, timeSec: number) {
      add(price, volume, timeSec)
    },
    reset() {
      current = null
      dirty = false
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