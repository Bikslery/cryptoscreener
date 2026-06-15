import type { UnifiedCandle, Exchange } from '../types'
import { isFiniteOHLCV, normalizeCandle } from './candle-utils'

export interface GapBackfill {
  /** Inclusive earliest missing period (epoch seconds, bucket-aligned). */
  fromTime: number
  /** Inclusive latest missing period (epoch seconds, bucket-aligned). */
  toTime: number
}

export interface CandlePatch {
  candleUpdates: UnifiedCandle[]
  volumeUpdates: UnifiedCandle[]
  livePrice?: number
  cacheWrites?: UnifiedCandle[]
  /**
   * Set when a new-period event (kline/trade) reveals one or more skipped
   * periods between the previous tail candle and the new one. Consumers
   * should fetch the missing candles via REST and apply them via
   * applyOlderPage() before painting this patch's candleUpdates.
   */
  gapBackfill?: GapBackfill
}

/**
 * Cap on how many missing periods a single detected gap may request via
 * REST backfill. Larger gaps (e.g. long WS outages) are left to the
 * reconnect/refresh path rather than firing a heavy request burst here.
 */
const MAX_BACKFILL_PERIODS = 10

export interface TradePayload {
  symbol: string
  exchange: Exchange
  price: number
  qty: number
  time: number
}

export interface CandleLifecycle {
  applyHistory(candles: UnifiedCandle[]): CandlePatch
  applyOlderPage(candles: UnifiedCandle[]): CandlePatch
  applyTrade(trade: TradePayload): CandlePatch
  applyKline(kline: UnifiedCandle): CandlePatch
  setBuffered(on: boolean): CandlePatch
  destroy(): void
}

interface CandleLifecycleOpts {
  symbol: string
  exchange: Exchange
  tf: string
  tfSeconds: number
}

interface TailEntry {
  candle: UnifiedCandle
  lastTradeAt: number
  lastKlineAt: number
}

const EMPTY_PATCH: CandlePatch = { candleUpdates: [], volumeUpdates: [] }

function emptyPatch(): CandlePatch {
  return { candleUpdates: [], volumeUpdates: [] }
}

let seq = 0
function nextSeq(): number { return ++seq }

/**
 * Compute a backfill range when `newTime` skips one or more periods after
 * `prevTime`. Returns null when the times are adjacent (no gap), when the
 * gap exceeds MAX_BACKFILL_PERIODS (deferred to reconnect logic), or when
 * either bound is non-finite / misordered.
 */
function detectGap(prevTime: number, newTime: number, tfSeconds: number): GapBackfill | null {
  if (!isFinite(prevTime) || !isFinite(newTime) || newTime <= prevTime) return null
  const periods = Math.round((newTime - prevTime) / tfSeconds)
  if (periods <= 1) return null
  if (periods - 1 > MAX_BACKFILL_PERIODS) return null
  return {
    fromTime: prevTime + tfSeconds,
    toTime: newTime - tfSeconds,
  }
}

export function createCandleLifecycle(opts: CandleLifecycleOpts): CandleLifecycle {
  const { symbol, exchange, tf, tfSeconds } = opts

  let tail: TailEntry[] = []
  let buffered = false
  let destroyed = false
  let bufferedTrade: TradePayload | null = null
  let bufferedKline: UnifiedCandle | null = null

  function getTailIndex(time: number): number {
    return tail.findIndex(t => t.candle.time === time)
  }

  function getCurrentForming(): TailEntry | null {
    if (tail.length === 0) return null
    return tail[tail.length - 1]
  }

  function pushTail(entry: TailEntry) {
    tail.push(entry)
    if (tail.length > 3) {
      tail = tail.slice(tail.length - 3)
    }
  }

  function updateTailEntry(index: number, candle: UnifiedCandle, source: 'trade' | 'kline') {
    const existing = tail[index]
    tail[index] = {
      candle,
      lastTradeAt: source === 'trade' ? nextSeq() : existing.lastTradeAt,
      lastKlineAt: source === 'kline' ? nextSeq() : existing.lastKlineAt,
    }
  }

  function patchFromCandles(candles: UnifiedCandle[], livePrice?: number, cacheWrites?: UnifiedCandle[], gapBackfill?: GapBackfill): CandlePatch {
    const patch = emptyPatch()
    const normalized = candles.map(normalizeCandle)
    patch.candleUpdates = normalized
    patch.volumeUpdates = normalized
    if (livePrice != null) patch.livePrice = livePrice
    if (cacheWrites && cacheWrites.length > 0) patch.cacheWrites = normalized
    if (gapBackfill) patch.gapBackfill = gapBackfill
    return patch
  }

  function applyHistory(candles: UnifiedCandle[]): CandlePatch {
    if (destroyed) return EMPTY_PATCH

    const valid = candles.filter(c => isFiniteOHLCV(c) && c.time > 0)
    if (valid.length === 0) return emptyPatch()

    tail = []
    const start = Math.max(0, valid.length - 3)
    for (let i = start; i < valid.length; i++) {
      tail.push({
        candle: { ...valid[i], source: valid[i].source || 'kline' },
        lastTradeAt: 0,
        lastKlineAt: valid[i].source === 'kline' ? nextSeq() : 0,
      })
    }

    return patchFromCandles(valid, undefined, valid)
  }

  function applyOlderPage(candles: UnifiedCandle[]): CandlePatch {
    if (destroyed) return EMPTY_PATCH

    const valid = candles.filter(c => isFiniteOHLCV(c) && c.time > 0)
    if (valid.length === 0) return emptyPatch()

    const earliestTail = tail.length > 0 ? tail[0].candle.time : Infinity
    const older = valid.filter(c => c.time < earliestTail)

    return patchFromCandles(older, undefined, older)
  }

  function applyTrade(trade: TradePayload): CandlePatch {
    if (destroyed) return EMPTY_PATCH
    if (!isFinite(trade.price) || !isFinite(trade.qty) || !isFinite(trade.time)) return EMPTY_PATCH

    const tradeSec = trade.time
    const candleTime = Math.floor(tradeSec / tfSeconds) * tfSeconds

    const current = getCurrentForming()
    let updatedCandles: UnifiedCandle[] = []

    if (!current) {
      const open = trade.price
      const newCandle: UnifiedCandle = {
        symbol, exchange, timeframe: tf,
        time: candleTime,
        open,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.qty,
        source: 'trade',
      }
      // No prior tail candle → no reference point for a gap.
      pushTail({
        candle: newCandle,
        lastTradeAt: nextSeq(),
        lastKlineAt: 0,
      })
      updatedCandles = [newCandle]
    } else if (candleTime === current.candle.time || tradeSec === current.candle.time) {
      const existing = current.candle
      const updated: UnifiedCandle = {
        ...existing,
        high: Math.max(existing.high, trade.price),
        low: Math.min(existing.low, trade.price),
        close: trade.price,
        volume: existing.volume + trade.qty,
        source: 'trade',
      }
      const idx = getTailIndex(existing.time)
      if (idx >= 0) updateTailEntry(idx, updated, 'trade')
      updatedCandles = [updated]
    } else if (tradeSec < current.candle.time) {
      return EMPTY_PATCH
    } else {
      const open = trade.price
      const gap = detectGap(current.candle.time, candleTime, tfSeconds)
      const newCandle: UnifiedCandle = {
        symbol, exchange, timeframe: tf,
        time: candleTime,
        open,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.qty,
        source: 'trade',
      }
      pushTail({
        candle: newCandle,
        lastTradeAt: nextSeq(),
        lastKlineAt: 0,
      })
      updatedCandles = [newCandle]
      if (buffered) {
        bufferedTrade = trade
        return EMPTY_PATCH
      }
      return patchFromCandles(updatedCandles, trade.price, updatedCandles, gap)
    }

    if (buffered) {
      bufferedTrade = trade
      return EMPTY_PATCH
    }

    return patchFromCandles(updatedCandles, trade.price, updatedCandles)
  }

  function applyKline(kline: UnifiedCandle): CandlePatch {
    if (destroyed) return EMPTY_PATCH
    if (!isFiniteOHLCV(kline) || kline.time <= 0) return EMPTY_PATCH

    const idx = getTailIndex(kline.time)
    if (idx < 0) {
      // Candle for this period is not yet in the tail. We must paint it when
      // it is a NEW period ahead of the tail — regardless of isFinal. The old
      // guard `&& !kline.isFinal` dropped a candle whose first WS message for
      // the period already carried isFinal=true (common during Binance load
      // spikes), leaving a horizontal hole on the chart.
      const lastTailTime = tail.length > 0 ? tail[tail.length - 1].candle.time : null
      if (lastTailTime != null && kline.time > lastTailTime) {
        const gap = detectGap(lastTailTime, kline.time, tfSeconds)
        const prevClose = tail[tail.length - 1].candle.close
        const newCandle: UnifiedCandle = {
          ...kline,
          symbol, exchange, timeframe: tf,
          open: isFinite(kline.open) && kline.open > 0 ? kline.open : prevClose,
          source: 'kline',
        }
        pushTail({
          candle: newCandle,
          lastTradeAt: 0,
          lastKlineAt: nextSeq(),
        })
        if (buffered) {
          bufferedKline = kline
          return EMPTY_PATCH
        }
        return patchFromCandles([newCandle], kline.close, [newCandle], gap)
      }
      // kline.time is older than the tail window (or before any tail entry):
      // stale/out-of-window update — ignore, just like before.
      return EMPTY_PATCH
    }

    const existing = tail[idx]
    const updatedCandles: UnifiedCandle[] = []

    if (kline.isFinal) {
      const finalized: UnifiedCandle = {
        ...kline,
        symbol, exchange, timeframe: tf,
        source: 'kline',
      }
      updateTailEntry(idx, finalized, 'kline')
      updatedCandles.push(finalized)

      const forming = tail.find(t => t.candle.time > kline.time)
      if (forming) {
        updatedCandles.push(forming.candle)
      }
    } else {
      const existingCandle = existing.candle
      const tradeIsNewer = existing.lastTradeAt > existing.lastKlineAt

      if (tradeIsNewer) {
        const merged: UnifiedCandle = {
          ...existingCandle,
          open: kline.open,
          high: Math.max(existingCandle.high, kline.high),
          low: Math.min(existingCandle.low, kline.low),
          volume: kline.volume,
          source: 'kline',
        }
        updateTailEntry(idx, merged, 'kline')
        updatedCandles.push(merged)
      } else {
        const replaced: UnifiedCandle = {
          ...kline,
          symbol, exchange, timeframe: tf,
          source: 'kline',
        }
        updateTailEntry(idx, replaced, 'kline')
        updatedCandles.push(replaced)
      }
    }

    if (buffered) {
      bufferedKline = kline
      return EMPTY_PATCH
    }

    const livePrice = !kline.isFinal ? kline.close : undefined
    return patchFromCandles(updatedCandles, livePrice, updatedCandles)
  }

  function setBuffered(on: boolean): CandlePatch {
    if (destroyed) return EMPTY_PATCH

    buffered = on
    if (on) return EMPTY_PATCH

    const patch = emptyPatch()

    if (bufferedKline) {
      const saved = buffered
      buffered = false
      const klinePatch = applyKline(bufferedKline)
      buffered = saved
      mergePatch(patch, klinePatch)
      bufferedKline = null
    }

    if (bufferedTrade) {
      const saved = buffered
      buffered = false
      const tradePatch = applyTrade(bufferedTrade)
      buffered = saved
      mergePatch(patch, tradePatch)
      bufferedTrade = null
    }

    return patch
  }

  function mergePatch(target: CandlePatch, source: CandlePatch) {
    target.candleUpdates.push(...source.candleUpdates)
    target.volumeUpdates.push(...source.volumeUpdates)
    if (source.livePrice != null) target.livePrice = source.livePrice
    if (source.cacheWrites) {
      if (!target.cacheWrites) target.cacheWrites = []
      target.cacheWrites.push(...source.cacheWrites)
    }
    if (source.gapBackfill) target.gapBackfill = source.gapBackfill
  }

  function destroy() {
    destroyed = true
    tail = []
    bufferedTrade = null
    bufferedKline = null
  }

  return {
    applyHistory,
    applyOlderPage,
    applyTrade,
    applyKline,
    setBuffered,
    destroy,
  }
}
