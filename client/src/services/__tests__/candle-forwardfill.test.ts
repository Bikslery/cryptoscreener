import { describe, it, expect } from 'vitest'
import { createCandleEvents } from '../candle-events'
import { forwardFillGap, isFlatFiller, MAX_FORWARD_FILL_PERIODS } from '../candle-utils'
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
