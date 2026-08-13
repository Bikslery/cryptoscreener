import { describe, it, expect } from 'vitest'
import { createCandleEvents, toChartTime, type CandleEvents, type TickPayload } from '../candle-events'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance-futures'
const SYM = 'BTCUSDT'
const TF = '1m'
const TF_SEC = 60

function makeCandle(time: number, o: number, h: number, l: number, c: number, v = 0): UnifiedCandle {
  return { symbol: SYM, exchange: EX, timeframe: TF, time, open: o, high: h, low: l, close: c, volume: v }
}
function tick(price: number, time: number): TickPayload {
  return { price, timeSec: time }
}
function makeEvents(): CandleEvents {
  return createCandleEvents({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
}
function lastBar(patch: { updates: { bar: UnifiedCandle }[] }): UnifiedCandle {
  const u = patch.updates[patch.updates.length - 1]
  if (!u) throw new Error('no updates in patch')
  return u.bar
}

// Reference model = scalpboard.io's extracted behavior (Cn/En/we):
//  - kline snapshot → FULL replace of the bar (open/high/low/close/volume).
//  - price tick → mutate ONLY close/high/low of the LAST bar; open and
//    volume are never touched; guard = tick belongs to (barStart, barStart+tf).
//  - no client-side aggregation, no gap backfill, no synthetic candles.
describe('candle-events (scalpboard parity)', () => {
  it('kline snapshot for a new period APPENDS the bar and paints volume', () => {
    const ev = makeEvents()
    const p = ev.applyKline(makeCandle(300, 100, 101, 99, 100.5, 12))
    expect(p.updates).toHaveLength(1)
    expect(p.updates[0].paintVolume).toBe(true)
    expect(p.livePrice).toBe(100.5)
    expect(p.cacheWrites?.[0].time).toBe(300)

    const p2 = ev.applyKline(makeCandle(360, 101, 102, 100, 101.5, 34))
    expect(p2.updates[0].bar.time).toBe(360)
    expect(lastBar(p2).open).toBe(101)
    expect(p2.updates[0].paintVolume).toBe(true)
  })

  it('kline snapshot for the SAME period fully REPLACES the bar (no merge)', () => {
    const ev = makeEvents()
    ev.applyKline(makeCandle(300, 100, 101, 99, 100.5, 12))
    const p = ev.applyKline(makeCandle(300, 99.5, 100.4, 99.1, 100.1, 7))
    const bar = lastBar(p)
    expect(bar).toEqual({
      symbol: SYM, exchange: EX, timeframe: TF,
      time: 300, open: 99.5, high: 100.4, low: 99.1, close: 100.1, volume: 7,
    })
    expect(p.updates[0].paintVolume).toBe(true)
  })

  it('price tick mutates only close/high/low; open and volume untouched', () => {
    const ev = makeEvents()
    ev.applyKline(makeCandle(300, 100, 101, 99, 100.5, 12))

    const p = ev.applyTick(tick(100.8, 318))
    const bar = lastBar(p)
    expect(bar.open).toBe(100)
    expect(bar.volume).toBe(12)
    expect(bar.close).toBe(100.8)
    expect(bar.high).toBe(101)
    expect(bar.low).toBe(99)
    expect(p.updates[0].paintVolume).toBe(false)
    expect(p.livePrice).toBe(100.8)

    const p2 = ev.applyTick(tick(102, 330))
    expect(lastBar(p2).high).toBe(102)
    const p3 = ev.applyTick(tick(98.5, 340))
    expect(lastBar(p3).low).toBe(98.5)
    expect(lastBar(p3).open).toBe(100)
    expect(lastBar(p3).volume).toBe(12)
  })

  it('tick outside (barStart, barStart+tf) is DROPPED (no synthetic candle)', () => {
    const ev = makeEvents()
    ev.applyKline(makeCandle(300, 100, 101, 99, 100.5, 12))

    expect(ev.applyTick(tick(101, 299)).updates).toHaveLength(0)
    expect(ev.applyTick(tick(101, 300)).updates).toHaveLength(0)
    expect(ev.applyTick(tick(101, 360)).updates).toHaveLength(0)
    expect(ev.applyTick(tick(101, 361)).updates).toHaveLength(0)
  })

  it('identical consecutive tick prices are deduped', () => {
    const ev = makeEvents()
    ev.applyKline(makeCandle(300, 100, 101, 99, 100.5, 12))
    expect(ev.applyTick(tick(100.8, 318)).updates).toHaveLength(1)
    expect(ev.applyTick(tick(100.8, 319)).updates).toHaveLength(0)
    expect(ev.applyTick(tick(100.8, 320)).updates).toHaveLength(0)
    expect(ev.applyTick(tick(100.9, 321)).updates).toHaveLength(1)
  })

  it('tick without an opened bar is dropped', () => {
    const ev = makeEvents()
    expect(ev.applyTick(tick(100.5, 1)).updates).toHaveLength(0)
  })

  it('stale kline (older than tail) is ignored — history never repainted live', () => {
    const ev = makeEvents()
    ev.applyKline(makeCandle(300, 100, 101, 99, 100.5, 12))
    ev.applyKline(makeCandle(360, 101, 102, 100, 101.5, 34))
    expect(ev.applyKline(makeCandle(300, 99, 100, 98, 99.5, 5)).updates).toHaveLength(0)
  })

  it('applyHistory seeds the tail; ticks then mutate the last history candle', () => {
    const ev = makeEvents()
    ev.applyHistory([
      makeCandle(180, 98, 99, 97, 98.5, 3),
      makeCandle(240, 98.5, 99.5, 98, 99, 8),
      makeCandle(300, 99, 100, 98.5, 99.5, 11),
    ])
    const p = ev.applyTick(tick(100.2, 318))
    const bar = lastBar(p)
    expect(bar.time).toBe(300)
    expect(bar.close).toBe(100.2)
    expect(bar.high).toBe(100.2)
    expect(bar.open).toBe(99)
    expect(bar.volume).toBe(11)
  })

  it('buffered events replay in order after history load (reconcile)', () => {
    const ev = makeEvents()
    ev.setBuffered(true)

    ev.applyKline(makeCandle(420, 103, 104, 102, 103.5, 20))
    ev.applyTick(tick(103.8, 430))

    ev.applyHistory([
      makeCandle(180, 98, 99, 97, 98.5, 3),
      makeCandle(240, 98.5, 99.5, 98, 99, 8),
      makeCandle(300, 99, 100, 98.5, 99.5, 11),
      makeCandle(360, 99.5, 101, 99, 100.5, 15),
    ])

    const flush = ev.setBuffered(false)
    expect(flush.updates.map(u => u.bar.time)).toEqual([420, 420])
    expect(flush.updates[0].paintVolume).toBe(true)
    expect(flush.updates[1].paintVolume).toBe(false)
    expect(flush.updates[1].bar.close).toBe(103.8)
    expect(flush.updates[1].bar.open).toBe(103)
    expect(flush.updates[1].bar.volume).toBe(20)
    expect(flush.livePrice).toBe(103.8)
  })

  it('stale kline inside the buffer is dropped on replay, newer ones win', () => {
    const ev = makeEvents()
    ev.setBuffered(true)
    ev.applyKline(makeCandle(420, 103, 104, 102, 103.5, 20))
    // Late snapshot for the ALREADY-PAINTED 360s period arrives mid-fetch.
    ev.applyKline(makeCandle(360, 99, 99.5, 98.7, 99.1, 1))
    ev.applyTick(tick(104, 440))

    const flush = ev.setBuffered(false)
    // The stale 360s kline is dropped against the seeded tail (applyHistory).
    expect(flush.updates.map(u => u.bar.time)).toEqual([420, 420])
    expect(lastBar(flush).close).toBe(104)
    expect(lastBar(flush).volume).toBe(20)
  })

  it('bounded buffer: more than 1000 buffered events never balloons', () => {
    const ev = makeEvents()
    ev.setBuffered(true)
    // All ticks must land inside the tail window (60, 120) so the replay
    // applies them; 1200 events pushed, only the last 1000 survive the cap.
    for (let i = 0; i < 1200; i++) ev.applyTick(tick(100 + i * 0.001, 61 + (i % 58)))
    ev.applyHistory([makeCandle(60, 90, 92, 89, 91, 1)])
    const flush = ev.setBuffered(false)
    expect(flush.updates.length).toBeGreaterThan(0)
    expect(flush.updates.length).toBeLessThanOrEqual(1000)
    expect(lastBar(flush).time).toBe(60)
    expect(lastBar(flush).close).toBe(100 + 1199 * 0.001)
  })

  it('toChartTime shifts by the fixed local offset (UTC stays raw)', () => {
    const offset = new Date().getTimezoneOffset() * 60
    expect(toChartTime(300)).toBe(300 - offset)
    expect(toChartTime(300 + offset)).toBe(300)
  })
})

describe('chart-viewport scaffold (no lightweight-charts needed)', () => {
  it('createCandleEvents stamps symbol/exchange/timeframe onto klines', () => {
    const ev = makeEvents()
    ev.applyKline({ symbol: 'X', exchange: 'binance' as Exchange, timeframe: '1h', time: 300, open: 1, high: 2, low: 1, close: 1.5, volume: 3 })
    const bar = lastBar(ev.applyTick(tick(1.6, 301)) as { updates: { bar: UnifiedCandle }[] })
    expect(bar.symbol).toBe(SYM)
    expect(bar.exchange).toBe(EX)
    expect(bar.timeframe).toBe(TF)
  })
})