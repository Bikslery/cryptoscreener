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
})
