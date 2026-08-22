import { describe, it, expect } from 'vitest'
import { createCandleEvents } from '../candle-events'
import { forwardFillGap, isFlatFiller, MAX_FORWARD_FILL_PERIODS, sanitizeCandles, mergeCandleSeries } from '../candle-utils'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance-futures'
const SYM = 'ROBOUSDT'
const TF = '1m'

function candle(time: number, close: number, volume = 10): UnifiedCandle {
  return { symbol: SYM, exchange: EX, timeframe: TF, time, open: close - 1, high: close + 2, low: close - 3, close, volume }
}

describe('forwardFillGap — period-jump bridge bars', () => {
  it('bridges skipped periods with flat bars anchored to the previous close', () => {
    const last = candle(300, 100)
    const fillers = forwardFillGap(last, 300 + 5 * 60, 60)
    expect(fillers).toHaveLength(4)
    expect(fillers.map(f => f.time)).toEqual([360, 420, 480, 540])
    for (const f of fillers) {
      expect(f.open).toBe(100)
      expect(f.high).toBe(100)
      expect(f.low).toBe(100)
      expect(f.close).toBe(100)
      expect(f.volume).toBe(0)
      expect(f.isFinal).toBe(true)
    }
    // Symbol/exchange/timeframe metadata carried over from the anchor bar.
    expect(fillers[0].symbol).toBe(SYM)
    expect(fillers[0].exchange).toBe(EX)
    expect(fillers[0].timeframe).toBe(TF)
  })

  it('caps the fill at MAX_FORWARD_FILL_PERIODS', () => {
    const last = candle(0, 50)
    const hugeJump = 60 * (MAX_FORWARD_FILL_PERIODS + 500)
    const fillers = forwardFillGap(last, hugeJump, 60)
    expect(fillers).toHaveLength(MAX_FORWARD_FILL_PERIODS)
    // Last filler stays strictly BEFORE the incoming bar time.
    expect(fillers[fillers.length - 1].time).toBeLessThan(hugeJump)
  })

  it('returns nothing when the incoming bar is adjacent', () => {
    const last = candle(300, 100)
    expect(forwardFillGap(last, 360, 60)).toHaveLength(0)
  })
})

describe('isFlatFiller — synthetic bridge detection', () => {
  it('matches flat zero-volume bars only', () => {
    expect(isFlatFiller(candle(300, 100, 0))).toBe(false) // real candle shape has o/h/l spread
    const flat = { ...candle(300, 100), volume: 0, open: 100, high: 100, low: 100, close: 100 }
    expect(isFlatFiller(flat)).toBe(true)
    // Same shape but with volume → a genuinely doji-ish real bar, NOT a filler.
    const realDoji = { ...flat, volume: 5 }
    expect(isFlatFiller(realDoji)).toBe(false)
  })
})

describe('candle-events.forwardFill — tail bookkeeping without patches', () => {
  function makeEvents() {
    return createCandleEvents({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: 60 })
  }

  it('advances the tail so tick windows follow the filled series', () => {
    const ev = makeEvents()
    ev.applyKline(candle(300, 100))
    // Jump 4 periods ahead (300 → 540) ⇒ fillers at 360/420/480.
    ev.forwardFill(forwardFillGap(candle(300, 100), 300 + 4 * 60, 60))
    const tail = ev.peekTail(3)
    expect(tail.map(t => t.time)).toEqual([360, 420, 480])
    // A tick inside the LAST filled period is now inside the window guard.
    const p = ev.applyTick({ price: 101, timeSec: 480 + 30 })
    expect(p.updates).toHaveLength(1)
    expect(p.updates[0].bar.close).toBe(101)
  })

  it('ignores fillers that are not newer than the current tail', () => {
    const ev = makeEvents()
    ev.applyKline(candle(600, 100))
    ev.forwardFill([candle(300, 99, 0), candle(600, 99, 0)])
    expect(ev.peekTail(1)[0].time).toBe(600)
  })

  it('is inert after destroy()', () => {
    const ev = makeEvents()
    ev.applyKline(candle(300, 100))
    ev.destroy()
    expect(() => ev.forwardFill([candle(360, 100, 0)])).not.toThrow()
    expect(ev.peekTail()).toHaveLength(0)
  })
})

describe('sanitizeCandles — history normalization before setData', () => {
  function bar(time: number, close: number): UnifiedCandle {
    return { symbol: SYM, exchange: EX, timeframe: TF, time, open: close - 1, high: close + 1, low: close - 2, close, volume: 7 }
  }

  it('returns the input by reference when already clean', () => {
    const input = [bar(60, 10), bar(120, 11), bar(180, 12)]
    expect(sanitizeCandles(input)).toBe(input)
  })

  it('NEVER fabricates rows for holes — history stays honest', () => {
    const input = [bar(60, 100), bar(300, 110), bar(360, 111)]
    const out = sanitizeCandles(input)
    // The 120..240 hole renders as whitespace until healed server-side;
    // no fake flat dojis are inserted.
    expect(out.map(c => c.time)).toEqual([60, 300, 360])
    expect(out.every(c => !isFlatFiller(c))).toBe(true)
  })

  it('drops invalid candles (NaN, inverted wicks)', () => {
    const broken = { ...bar(180, 11), high: NaN }
    const inverted = { ...bar(240, 12), high: 5, low: 20 } // high < low
    const out = sanitizeCandles([bar(120, 10), broken, inverted, bar(300, 13)])
    // Corrupt rows are DROPPED, not "repaired": fixing a high<low candle into
    // a wide-range bar would paint a phantom price spike. A hole is honest.
    expect(out.map(c => c.time)).toEqual([120, 300])
  })

  it('dedupes by time keeping the LAST occurrence and sorts ascending', () => {
    const stale = bar(120, 11)
    const fresh = { ...bar(120, 99) }
    const out = sanitizeCandles([bar(180, 12), stale, bar(60, 10), fresh])
    expect(out.map(c => c.time)).toEqual([60, 120, 180])
    expect(out[1].close).toBe(99)
  })
})

describe('mergeCandleSeries — regression-free union of painted and fetched', () => {
  function bar(time: number, close: number): UnifiedCandle {
    return { symbol: SYM, exchange: EX, timeframe: TF, time, open: close - 1, high: close + 1, low: close - 2, close, volume: 7 }
  }

  it('keeps live bars NEWER than the incoming tail (no tail regression)', () => {
    const painted = [bar(0, 10), bar(60, 11), bar(120, 12), bar(180, 13)]
    const fetched = [bar(0, 10), bar(60, 11)] // ends BEFORE the painted tail
    const out = mergeCandleSeries(painted, fetched)
    expect(out.map(c => c.time)).toEqual([0, 60, 120, 180])
    expect(out[out.length - 1].close).toBe(13)
  })

  it('incoming wins collisions (fresher server snapshot replaces stale rows)', () => {
    const painted = [bar(0, 10), bar(60, 99)]
    const fetched = [bar(60, 55), bar(120, 56)]
    const out = mergeCandleSeries(painted, fetched)
    expect(out.map(c => c.time)).toEqual([0, 60, 120])
    expect(out[1].close).toBe(55)
  })

  it('returns inputs untouched at the extremes', () => {
    const a = [bar(0, 10)]
    const b = [bar(60, 11)]
    expect(mergeCandleSeries(a, [])).toBe(a)
    expect(mergeCandleSeries([], b)).toBe(b)
  })
})
