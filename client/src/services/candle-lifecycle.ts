import type { UnifiedCandle, Exchange } from '../types'

export interface CandlePatch {
  candleUpdates: UnifiedCandle[]
  volumeUpdates: UnifiedCandle[]
  livePrice?: number
  cacheWrites?: UnifiedCandle[]
}

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

function isFiniteOHLCV(c: { open: number; high: number; low: number; close: number; volume: number }): boolean {
  return isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) && isFinite(c.volume)
}

let seq = 0
function nextSeq(): number { return ++seq }

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

  function getPreviousClose(): number | null {
    if (tail.length === 0) return null
    return tail[tail.length - 1].candle.close
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

  function patchFromCandles(candles: UnifiedCandle[], livePrice?: number, cacheWrites?: UnifiedCandle[]): CandlePatch {
    const patch = emptyPatch()
    patch.candleUpdates = candles
    patch.volumeUpdates = candles
    if (livePrice != null) patch.livePrice = livePrice
    if (cacheWrites && cacheWrites.length > 0) patch.cacheWrites = cacheWrites
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
    // [DIAG] Phase 4: track tail population after applyHistory
    console.log(`[DIAG applyHistory] tail populated ${JSON.stringify({ symbol, exchange, tf, tailTimes: tail.map(t => t.candle.time), tailExchanges: tail.map(t => t.candle.exchange), validCount: valid.length })}`)

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
      const prevClose = getPreviousClose()
      const open = prevClose != null ? prevClose : trade.price
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
      const prevClose = current.candle.close
      const open = prevClose
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
    // [DIAG] Phase 4: log EVERY applyKline call — track whether WS data reaches here
    console.log(`[DIAG applyKline] called ${JSON.stringify({ symbol, exchange, tf, klineTime: kline.time, klineExchange: kline.exchange, klineIsFinal: kline.isFinal, idx, tailTimes: tail.map(t => t.candle.time) })}`)
    if (idx < 0) {
    console.warn(`[DIAG applyKline] kline.time not in tail ${JSON.stringify({ symbol, exchange, tf, klineTime: kline.time, klineExchange: kline.exchange, tailTimes: tail.map(t => t.candle.time), tailLength: tail.length, klineIsFinal: kline.isFinal })}`)
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
