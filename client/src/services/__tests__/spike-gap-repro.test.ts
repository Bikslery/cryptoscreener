import { describe, it, expect } from 'vitest'
import { createCandleLifecycle, type TradePayload } from '../candle-lifecycle'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance_futures' as Exchange
const SYM = 'BTCUSDT'
const TF = '1m'
const TF_SEC = 60

function makeCandle(time: number, o: number, h: number, l: number, c: number, v = 0): UnifiedCandle {
  return { symbol: SYM, exchange: EX, timeframe: TF, time, open: o, high: h, low: l, close: c, volume: v, source: 'kline' }
}
function makeTrade(time: number, price: number, qty = 1): TradePayload {
  return { symbol: SYM, exchange: EX, price, qty, time }
}

// Mirror of candle-cache.ts validateCandle OHLC-relationship checks
function ohlcValid(c: UnifiedCandle): boolean {
  if (c.high < c.low) return false
  if (c.high < c.open || c.high < c.close) return false
  if (c.low > c.open || c.low > c.close) return false
  return true
}
// Mirror of ChartGrid.applyChartPatch draw guard (only finiteness)
function drawGuardPasses(c: UnifiedCandle): boolean {
  return isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)
}

describe('SPIKE-GAP repro: sharp spike produces a malformed candle', () => {
  it('up-spike: open = first trade price, OHLC valid', () => {
    const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
    lc.applyHistory([makeCandle(300, 98, 101, 97, 100, 50)])

    const patch = lc.applyTrade(makeTrade(360, 130, 5))
    const c = patch.candleUpdates[0]

    expect(c.time).toBe(360)
    expect(c.open).toBe(130)
    expect(c.high).toBe(130)
    expect(c.low).toBe(130)
    expect(c.close).toBe(130)

    expect(drawGuardPasses(c)).toBe(true)
    expect(ohlcValid(c)).toBe(true)
  })

  it('down-spike: open = first trade price, OHLC valid', () => {
    const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
    lc.applyHistory([makeCandle(300, 98, 101, 99, 100, 50)])

    const patch = lc.applyTrade(makeTrade(360, 70, 5))
    const c = patch.candleUpdates[0]

    expect(c.open).toBe(70)
    expect(c.high).toBe(70)
    expect(c.low).toBe(70)
    expect(c.close).toBe(70)
    expect(drawGuardPasses(c)).toBe(true)
    expect(ohlcValid(c)).toBe(true)
  })

  // Reveals the true scope: it is NOT spike-specific in the lifecycle.
  // Because open is pinned to prevClose while high/low/close = first trade price,
  // EVERY new trade-built candle whose first trade != prevClose is malformed.
  // Spikes just make the malformed body huge and its disappearance glaring.
  it('tiny up-tick: open = first trade price, OHLC valid', () => {
    const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
    lc.applyHistory([makeCandle(300, 98, 101, 97, 100, 50)])
    const patch = lc.applyTrade(makeTrade(360, 100.5, 5))
    const c = patch.candleUpdates[0]
    expect(c.open).toBe(100.5)
    expect(c.high).toBe(100.5)
    expect(c.low).toBe(100.5)
    expect(c.close).toBe(100.5)
    expect(ohlcValid(c)).toBe(true)
  })

  it('FIX shape: open clamped into [low,high] (= first trade price) is valid', () => {
    // Demonstrates the intended fix: open of a trade-built candle must be the
    // first trade price (or clamped into the OHLC range), not the prev close.
    const fixedUp = makeCandle(360, 130, 130, 130, 130) // open = first trade
    expect(ohlcValid(fixedUp)).toBe(true)
  })
})
