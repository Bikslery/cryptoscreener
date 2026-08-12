import { describe, it, expect } from 'vitest'
import { createCandleLifecycle, type TradePayload } from '../candle-lifecycle'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance_futures' as Exchange
const SYM = 'BTCUSDT'
const TF = '1m'
const TF_SEC = 60

function makeCandle(time: number, o: number, h: number, l: number, c: number, v = 0, extra: Partial<UnifiedCandle> = {}): UnifiedCandle {
  return { symbol: SYM, exchange: EX, timeframe: TF, time, open: o, high: h, low: l, close: c, volume: v, source: 'kline', ...extra }
}

function makeTrade(time: number, price: number, qty = 1): TradePayload {
  return { symbol: SYM, exchange: EX, price, qty, time }
}

describe('candle-lifecycle', () => {
  describe('applyHistory', () => {
    it('seeds tail from last 3 candles', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const candles = [
        makeCandle(100, 1, 2, 0.5, 1.5, 10),
        makeCandle(160, 1.5, 2.5, 1, 2, 20),
        makeCandle(220, 2, 3, 1.5, 2.5, 30),
        makeCandle(280, 2.5, 3.5, 2, 3, 40),
        makeCandle(340, 3, 4, 2.5, 3.5, 50),
      ]
      const patch = lc.applyHistory(candles)
      expect(patch.candleUpdates).toHaveLength(5)
      expect(patch.cacheWrites).toHaveLength(5)
    })
  })

  describe('trade same candle', () => {
    it('extends existing forming candle', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(300, 100, 110, 95, 105, 50)]
      lc.applyHistory(hist)

      const patch = lc.applyTrade(makeTrade(320, 108, 2))
      expect(patch.candleUpdates).toHaveLength(1)
      const c = patch.candleUpdates[0]
      expect(c.time).toBe(300)
      expect(c.close).toBe(108)
      expect(c.high).toBe(110)
      expect(c.low).toBe(95)
      expect(c.volume).toBe(52)
      expect(c.source).toBe('trade')
    })
  })

  describe('delayed non-final kline does not move close backward', () => {
    it('keeps trade close when trade is newer', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(300, 100, 110, 95, 105, 50)]
      lc.applyHistory(hist)

      lc.applyTrade(makeTrade(320, 108, 2))

      const patch = lc.applyKline(makeCandle(300, 100, 109, 96, 106, 45))
      expect(patch.candleUpdates).toHaveLength(1)
      const c = patch.candleUpdates[0]
      expect(c.close).toBe(108)
      expect(c.open).toBe(100)
      expect(c.volume).toBe(45)
      expect(c.high).toBe(110)
      expect(c.low).toBe(95)
    })
  })

  describe('trade new interval creates new candle with open = first trade price', () => {
    it('uses first trade price as open for new candle', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(300, 100, 110, 95, 105, 50)]
      lc.applyHistory(hist)

      const patch = lc.applyTrade(makeTrade(360, 107, 3))
      expect(patch.candleUpdates).toHaveLength(1)
      const c = patch.candleUpdates[0]
      expect(c.time).toBe(360)
      expect(c.open).toBe(107)
      expect(c.close).toBe(107)
      expect(c.volume).toBe(3)
    })
  })

  describe('late final kline for previous candle', () => {
    it('finalizes previous candle and preserves current', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(300, 100, 110, 95, 105, 50)]
      lc.applyHistory(hist)

      lc.applyTrade(makeTrade(360, 107, 3))

      const patch = lc.applyKline(makeCandle(300, 100, 112, 94, 104, 48, { isFinal: true }))
      expect(patch.candleUpdates.length).toBeGreaterThanOrEqual(1)
      const finalized = patch.candleUpdates.find(c => c.time === 300)
      expect(finalized).toBeDefined()
      expect(finalized!.close).toBe(104)
      expect(finalized!.high).toBe(112)
      expect(finalized!.isFinal).toBe(true)
    })
  })

  describe('tradeSec === bar.time belongs to current candle', () => {
    it('does not create new candle when tradeSec equals bar.time', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(300, 100, 110, 95, 105, 50)]
      lc.applyHistory(hist)

      const patch = lc.applyTrade(makeTrade(300, 103, 1))
      expect(patch.candleUpdates).toHaveLength(1)
      expect(patch.candleUpdates[0].time).toBe(300)
    })
  })

  describe('stale trade ignored', () => {
    it('ignores trade with tradeSec < bar.time', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(360, 100, 110, 95, 105, 50)]
      lc.applyHistory(hist)

      const patch = lc.applyTrade(makeTrade(359, 99, 1))
      expect(patch.candleUpdates).toHaveLength(0)
    })
  })

  describe('buffered mode', () => {
    it('buffers trade and kline, flush applies latest', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(300, 100, 110, 95, 105, 50)]
      lc.applyHistory(hist)

      lc.setBuffered(true)

      const tradePatch = lc.applyTrade(makeTrade(320, 108, 2))
      expect(tradePatch.candleUpdates).toHaveLength(0)

      const klinePatch = lc.applyKline(makeCandle(300, 100, 109, 96, 107, 55))
      expect(klinePatch.candleUpdates).toHaveLength(0)

      const flushPatch = lc.setBuffered(false)
      expect(flushPatch.candleUpdates.length).toBeGreaterThan(0)
      const lastCandle = flushPatch.candleUpdates[flushPatch.candleUpdates.length - 1]
      expect(lastCandle.close).toBe(108)
    })

    it('does not double-count trade volume across buffered trades', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      lc.setBuffered(true)
      lc.applyTrade(makeTrade(310, 108, 2))
      lc.applyTrade(makeTrade(320, 109, 3))
      lc.applyTrade(makeTrade(340, 107, 5))

      const flush = lc.setBuffered(false)
      const last = flush.candleUpdates[flush.candleUpdates.length - 1]
      expect(last.time).toBe(300)
      expect(last.close).toBe(107)
      expect(last.volume).toBe(60) // 50 + 2 + 3 + 5 — no double counting
      expect(last.high).toBe(110)
      expect(last.low).toBe(95)
    })

    it('replays buffered events on top of freshly loaded history (reconciliation)', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      lc.setBuffered(true)
      lc.applyTrade(makeTrade(310, 106, 2)) // period 300 — superseded by finalized history
      lc.applyTrade(makeTrade(370, 109, 4)) // period 360 — new forming period

      // History lands during the fetch: 300 finalized, 360 forming.
      lc.applyHistory([
        makeCandle(300, 100, 110, 95, 105, 50, { isFinal: true }),
        makeCandle(360, 107, 109, 106, 108, 40),
      ])

      const flush = lc.setBuffered(false)
      const last = flush.candleUpdates[flush.candleUpdates.length - 1]
      expect(last.time).toBe(360)
      expect(last.close).toBe(109)
      expect(last.volume).toBe(44)
      expect(last.high).toBe(109)
      expect(last.low).toBe(106)
    })

    it('setBuffered(true) twice keeps accumulated events (idempotent begin)', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      lc.setBuffered(true)
      lc.applyTrade(makeTrade(320, 108, 2))
      lc.setBuffered(true) // paint() re-enters — must NOT drop the buffered trade
      const flush = lc.setBuffered(false)
      expect(flush.candleUpdates.length).toBeGreaterThan(0)
      expect(flush.candleUpdates[flush.candleUpdates.length - 1].close).toBe(108)
    })
  })

  describe('exchange change via destroy + create', () => {
    it('fresh module has no stale buffer', () => {
      const lc1 = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      const hist = [makeCandle(300, 100, 110, 95, 105, 50)]
      lc1.applyHistory(hist)
      lc1.applyTrade(makeTrade(320, 108, 2))
      lc1.destroy()

      const lc2 = createCandleLifecycle({ symbol: SYM, exchange: 'bybit' as Exchange, tf: TF, tfSeconds: TF_SEC })
      const patch = lc2.applyHistory([makeCandle(300, 200, 210, 195, 205, 60)])
      expect(patch.candleUpdates).toHaveLength(1)
      expect(patch.candleUpdates[0].close).toBe(205)

      const tradePatch = lc2.applyTrade(makeTrade(320, 208, 1))
      expect(tradePatch.candleUpdates[0].close).toBe(208)
    })
  })

  describe('kline outside tail returns empty patch', () => {
    it('ignores kline for candle not in tail', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      const patch = lc.applyKline(makeCandle(180, 99, 100, 98, 97, 30))
      expect(patch.candleUpdates).toHaveLength(0)
    })
  })

  describe('no previous candle: open = first trade price', () => {
    it('uses trade price as open when no history', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })

      const patch = lc.applyTrade(makeTrade(320, 105, 2))
      expect(patch.candleUpdates).toHaveLength(1)
      expect(patch.candleUpdates[0].open).toBe(105)
      expect(patch.candleUpdates[0].close).toBe(105)
    })
  })

  describe('applyHistory always returns patch even in buffered mode', () => {
    it('applyHistory ignores buffered mode', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.setBuffered(true)

      const patch = lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])
      expect(patch.candleUpdates).toHaveLength(1)
    })
  })

  describe('applyOlderPage ignores buffered mode', () => {
    it('applyOlderPage returns patch even when buffered', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])
      lc.setBuffered(true)

      const patch = lc.applyOlderPage([makeCandle(180, 99, 100, 98, 97, 30)])
      expect(patch.candleUpdates).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------
  // Regression: final kline for a new period must still create a candle.
  // Previously applyKline guarded new-candle creation with `!kline.isFinal`,
  // so a kline whose first WS message for the period already carried
  // isFinal=true (common during Binance load spikes) was dropped, leaving a
  // horizontal hole on the chart.
  // ---------------------------------------------------------------------
  describe('final kline for new period creates a candle', () => {
    it('creates the candle even when isFinal=true on first message', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      const patch = lc.applyKline(makeCandle(360, 105, 108, 103, 107, 40, { isFinal: true }))
      expect(patch.candleUpdates).toHaveLength(1)
      const c = patch.candleUpdates[0]
      expect(c.time).toBe(360)
      expect(c.isFinal).toBe(true)
      expect(c.open).toBe(105)
      expect(c.close).toBe(107)
      expect(c.high).toBe(108)
      expect(c.low).toBe(103)
    })

    it('creates the candle when isFinal=false (forming)', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      const patch = lc.applyKline(makeCandle(360, 105, 108, 103, 107, 40, { isFinal: false }))
      expect(patch.candleUpdates).toHaveLength(1)
      expect(patch.candleUpdates[0].time).toBe(360)
      expect(patch.candleUpdates[0].close).toBe(107)
    })

    it('open from kline is used, not prevClose, when kline.open is valid', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      // prevClose = 105; kline.open = 200 — open must be 200, not 105.
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      const patch = lc.applyKline(makeCandle(360, 200, 210, 195, 205, 10, { isFinal: true }))
      expect(patch.candleUpdates[0].open).toBe(200)
    })

    it('falls back to prevClose for open only when kline.open is invalid', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      // open: 0 (falsy) → fallback to prevClose = 105. normalizeCandle clamps
      // high/low afterwards, so the candle stays drawable.
      const patch = lc.applyKline(makeCandle(360, 0, 0, 0, 0, 10, { isFinal: true }))
      expect(patch.candleUpdates).toHaveLength(1)
      expect(patch.candleUpdates[0].open).toBe(105)
    })
  })

  // ---------------------------------------------------------------------
  // Gap detection: when a new-period event skips one or more buckets
  // (e.g. brief WS outage during sharp price action), the patch must carry
  // gapBackfill so the chart can REST-fetch the missing candles.
  // ---------------------------------------------------------------------
  describe('gapBackfill', () => {
    it('is reported when a kline skips periods', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      // 300 → 480 skips 360 and 420.
      const patch = lc.applyKline(makeCandle(480, 120, 125, 118, 122, 20))
      expect(patch.gapBackfill).toEqual({ fromTime: 360, toTime: 420 })
    })

    it('is reported when a trade skips periods', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      const patch = lc.applyTrade(makeTrade(480, 130, 5))
      expect(patch.gapBackfill).toEqual({ fromTime: 360, toTime: 420 })
    })

    it('is undefined when periods are adjacent (no gap)', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      const patch = lc.applyKline(makeCandle(360, 105, 108, 103, 107, 40))
      expect(patch.gapBackfill).toBeUndefined()
    })

    it('is undefined for very large gaps (deferred to reconnect logic)', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      // 300 → 300 + 20*60 = 1500 → 19 missing periods (> MAX_BACKFILL_PERIODS=10).
      const patch = lc.applyKline(makeCandle(1500, 200, 210, 195, 205, 30))
      expect(patch.gapBackfill).toBeUndefined()
      // The candle itself is still created (we don't drop it, just skip backfill).
      expect(patch.candleUpdates).toHaveLength(1)
    })
  })

  describe('applyMid (bookTicker fast-lane)', () => {
    it('moves the forming candle close/high/low without touching volume', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])
      // Seed the forming candle with a trade.
      lc.applyTrade(makeTrade(320, 108, 2))

      const patch = lc.applyMid(107.5)
      expect(patch.candleUpdates).toHaveLength(1)
      const c = patch.candleUpdates[0]
      expect(c.time).toBe(300)
      expect(c.close).toBe(107.5)
      expect(c.high).toBe(110)   // mid below the existing high
      expect(c.low).toBe(95)     // mid above the existing low
      expect(c.volume).toBe(52)  // unchanged — a mid is not a trade
      expect(c.source).toBe('mid')
      expect(patch.livePrice).toBe(107.5)
    })

    it('extends high/low when mid moves beyond the trade range', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])
      lc.applyTrade(makeTrade(320, 108, 2))

      const patch = lc.applyMid(112)
      const c = patch.candleUpdates[0]
      expect(c.close).toBe(112)
      expect(c.high).toBe(112)
      expect(c.low).toBe(95)
    })

    it('updates the tail candle even without a fresh trade — last history candle is the in-progress period', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      // REST history from Binance includes the in-progress period as the last
      // row, so applyMid treats it as the forming candle — same as applyTrade.
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      const patch = lc.applyMid(106)
      expect(patch.candleUpdates).toHaveLength(1)
      const c = patch.candleUpdates[0]
      expect(c.time).toBe(300)
      expect(c.close).toBe(106)
      expect(c.high).toBe(110)
      expect(c.low).toBe(95)
      expect(c.source).toBe('mid')
    })

    it('does not mark the candle as trade-newer — a later kline still replaces the mid range', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])
      lc.applyTrade(makeTrade(320, 108, 2))

      // A kline arrives (no mid yet) — after this, kline is newer than trade.
      lc.applyKline(makeCandle(300, 100, 109, 96, 106, 45))

      // Mid tries to inflate the high beyond the real market.
      lc.applyMid(112)

      // Next kline: because mid did NOT bump lastTradeAt, the kline is still
      // newer → applyKline replaces with real values instead of merging (which
      // would keep the inflated 112 high until finalization).
      const patch = lc.applyKline(makeCandle(300, 100, 107, 97, 105, 46))
      const c = patch.candleUpdates[0]
      expect(c.high).toBe(107)
      expect(c.close).toBe(105)
    })
  })

  describe('forming-candle open is pinned (no start teleport when kline arrives)', () => {
    it('keeps the trade-established open in the merge branch when a non-final kline has a different open', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])

      // New period opens with a trade at 108 — the candle's open is 108.
      lc.applyTrade(makeTrade(360, 108, 3))

      // The exchange's kline for the same period reports a DIFFERENT open (110)
      // — without pinning this teleported the body start. It must stay 108.
      // makeCandle(time, open, high, low, close, ...)
      const patch = lc.applyKline(makeCandle(360, 110, 111, 107, 109, 40, { isFinal: false }))
      const c = patch.candleUpdates[0]
      expect(c.time).toBe(360)
      expect(c.open).toBe(108)
      expect(c.high).toBe(111)
      expect(c.low).toBe(107)
      // Trade is newer than the kline → merge keeps the trade close (a delayed
      // kline never moves close backward); only high/low/volume merge in.
      expect(c.close).toBe(108)
    })

    it('keeps the established open in the replace branch across later klines', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])
      lc.applyTrade(makeTrade(320, 108, 2))

      // First kline: trade is newer → merge, open stays 100 (history open).
      lc.applyKline(makeCandle(300, 101, 109, 96, 106, 45))

      // Second kline with yet another open, no trade since → replace branch:
      // the open must STILL be pinned to the established 100, not flip to 102.
      const patch = lc.applyKline(makeCandle(300, 102, 108, 97, 105, 46))
      const c = patch.candleUpdates[0]
      expect(c.open).toBe(100)
      expect(c.close).toBe(105)
    })

    it('lets the FINAL kline apply the official open', () => {
      const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
      lc.applyHistory([makeCandle(300, 100, 110, 95, 105, 50)])
      lc.applyTrade(makeTrade(360, 108, 3))

      // Non-final kline with a different open — pinned to 108.
      lc.applyKline(makeCandle(360, 110, 111, 107, 109, 40, { isFinal: false }))

      // Final kline carries the official open 110 — now the candle is closed,
      // so the exact exchange values apply.
      const patch = lc.applyKline(makeCandle(360, 110, 112, 106, 111, 42, { isFinal: true }))
      const c = patch.candleUpdates[0]
      expect(c.open).toBe(110)
      expect(c.isFinal).toBe(true)
    })
  })
})
