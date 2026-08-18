import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSecondCandleAggregator, type SecondCandleAggregator, type SecondCandleAggregatorOpts } from '../second-candle-aggregator'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance-futures'
const SYM = 'BTCUSDT'
const TF = '1s'
const TF_SEC = 1

describe('second-candle-aggregator (scalpboard processTradeForSeconds parity)', () => {
  let emitted: UnifiedCandle[]
  let emittedTimes: number[]
  let agg: SecondCandleAggregator

  function makeAgg(tf = TF, tfSeconds = TF_SEC): SecondCandleAggregator {
    emitted = []
    emittedTimes = []
    const opts: SecondCandleAggregatorOpts = {
      symbol: SYM, exchange: EX, tf, tfSeconds,
      onCandle: (c) => { emitted.push(c); emittedTimes.push(c.time) },
    }
    agg = createSecondCandleAggregator(opts)
    return agg
  }

  beforeEach(() => {
    vi.useFakeTimers()
    makeAgg()
  })

  afterEach(() => {
    agg.destroy()
    vi.useRealTimers()
  })

  it('buckets trades by floor(timeSec / tfSec) * tfSec (UTC, no tz shift)', () => {
    agg.addTrade(100, 1, 3.9)
    // Bucket of t=3.9 on a 1s chart is second 3, not 4.
    vi.advanceTimersByTime(60)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].time).toBe(3)
  })

  it('opens a bar with open = high = low = close and accumulates volume', () => {
    agg.addTrade(100, 2, 10)
    agg.addTrade(101, 3, 10.5)
    agg.addTrade(99, 1, 10.9)
    vi.advanceTimersByTime(60)

    expect(emitted).toHaveLength(1)
    const bar = emitted[0]
    expect(bar.time).toBe(10)
    expect(bar.open).toBe(100)
    expect(bar.high).toBe(101)
    expect(bar.low).toBe(99)
    expect(bar.close).toBe(99)
    expect(bar.volume).toBe(6)
    expect(bar.symbol).toBe(SYM)
    expect(bar.exchange).toBe(EX)
    expect(bar.timeframe).toBe(TF)
  })

  it('flushes the CURRENT bar on the 50ms timer, but only when dirty', () => {
    agg.addTrade(100, 1, 10)
    vi.advanceTimersByTime(50)
    expect(emitted).toHaveLength(1)

    // No new prints → no repaint on the next tick.
    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(1)

    // A new print marks dirty again.
    agg.addTrade(100.5, 1, 10.9)
    vi.advanceTimersByTime(50)
    expect(emitted).toHaveLength(2)
    expect(emitted[1].close).toBe(100.5)
  })

  it('bucket switch pushes the previous bar out immediately (no 50ms loss)', () => {
    agg.addTrade(100, 1, 10)
    agg.addTrade(105, 2, 11.5)

    // Second trade belongs to bucket 11 → the t=10 bar must already be out.
    expect(emittedTimes).toEqual([10])
    expect(emitted[0]).toEqual(expect.objectContaining({ time: 10, close: 100 }))
  })

  it('opens a new bucket on the first print after a quiet gap', () => {
    agg.addTrade(100, 1, 10)
    agg.addTrade(110, 2, 20)
    expect(emittedTimes).toEqual([10])
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([10, 20])
    expect(emitted[1].open).toBe(110)
  })

  it('flat market: a new bar opens exactly at the previous close', () => {
    // The user-visible guarantee: open of a bar === close of the previous
    // one when the market did not move. With no mid lane, a bucket opens
    // only on the first real print, so same-price trades chain perfectly.
    agg.addTrade(100, 1, 9.5)
    agg.addTrade(100, 2, 9.9)
    agg.addTrade(100, 3, 10.3)

    expect(emittedTimes).toEqual([9])
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([9, 10])
    expect(emitted[0].close).toBe(100)
    expect(emitted[1].open).toBe(100)
  })

  it('ignores a late print for an already-closed bucket (no open repaint)', () => {
    // A delayed/out-of-order print (reconnect replay) must not roll the
    // series back: the previous bar was already flushed, the forming bucket
    // stays untouched and the new bucket's open is not overwritten.
    agg.addTrade(100, 1, 10)
    agg.addTrade(105, 2, 11)

    // Late print carrying a stale price for bucket 10.
    agg.addTrade(90, 1, 10.7)

    expect(emittedTimes).toEqual([10])
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([10, 11])
    expect(emitted[1]).toEqual(expect.objectContaining({ open: 105, close: 105, low: 105, volume: 2 }))
  })

  it('out-of-order prints within the same bucket still merge', () => {
    // The guard only drops prints for buckets OLDER than the current one.
    // Same-bucket out-of-order prints keep normal OHLC semantics.
    agg.addTrade(100, 1, 10.9)
    agg.addTrade(99, 1, 10.1)
    agg.addTrade(101, 1, 10.5)
    vi.advanceTimersByTime(50)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual(expect.objectContaining({ open: 100, high: 101, low: 99, close: 101, volume: 3 }))
  })

  it('reset() clears the open bar; a fresh print re-opens the bucket', () => {
    agg.addTrade(100, 1, 10)
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([10])

    // A flush resets dirty; the reset drops the OPEN bar entirely.
    agg.reset()
    agg.addTrade(105, 2, 11)
    expect(emittedTimes).toEqual([10])
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([10, 11])
    expect(emitted[1].open).toBe(105)
  })

  it('ignores invalid prints (non-positive price/time)', () => {
    agg.addTrade(0, 1, 10)
    agg.addTrade(100, 1, -5)
    agg.addTrade(NaN, 1, 10)
    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(0)
  })

  it('destroy() stops the flush timer', () => {
    agg.addTrade(100, 1, 10)
    agg.destroy()
    vi.advanceTimersByTime(200)
    expect(emitted).toHaveLength(0)
  })

  it('5s interval buckets on 5-second boundaries', () => {
    makeAgg('5s', 5)
    agg.addTrade(100, 1, 7)
    agg.addTrade(101, 1, 9)
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([5])

    agg.addTrade(102, 1, 10)
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([5, 10])
  })

  it('15s interval buckets on 15-second boundaries', () => {
    makeAgg('15s', 15)
    agg.addTrade(100, 1, 29)
    agg.addTrade(101, 1, 44.9)
    expect(emittedTimes).toEqual([15])
    vi.advanceTimersByTime(50)
    expect(emittedTimes).toEqual([15, 30])
  })
})