import { describe, it, expect, beforeEach } from 'vitest'
import * as candleCache from '../candle-cache'
import type { UnifiedCandle, Exchange } from '../../types'

const EX: Exchange = 'binance-futures'
const SYM = 'BTCUSDT'
const TF = '1m'

function makeCandle(time: number, o: number, h: number, l: number, c: number, v = 1): UnifiedCandle {
  return { symbol: SYM, exchange: EX, timeframe: TF, time, open: o, high: h, low: l, close: c, volume: v }
}

describe('candle-cache: prependCandles', () => {
  beforeEach(() => {
    candleCache.clearAll()
  })

  it('prepends an older page ahead of the existing (newer) candles, sorted by time', () => {
    candleCache.setCandles(EX, SYM, TF, [
      makeCandle(300, 10, 11, 9, 10.5),
      makeCandle(360, 10.5, 11.5, 10, 11),
    ])
    candleCache.prependCandles(EX, SYM, TF, [
      makeCandle(180, 8, 9, 7, 8.5),
      makeCandle(240, 8.5, 9.5, 8, 9),
    ])
    const merged = candleCache.getCandles(EX, SYM, TF)
    expect(merged?.map(c => c.time)).toEqual([180, 240, 300, 360])
  })

  it('dedups on the stitch point: current (newer) entries win over the older page at the same timestamp', () => {
    // The existing array already has a candle at 300 that has since been
    // mutated live (e.g. a late tick moved its close) — the older page's
    // OWN copy of 300 (from a REST refetch) must not clobber it.
    candleCache.setCandles(EX, SYM, TF, [
      makeCandle(300, 10, 12, 9, 11.7), // "live-mutated" version
    ])
    candleCache.prependCandles(EX, SYM, TF, [
      makeCandle(240, 8.5, 9.5, 8, 9),
      makeCandle(300, 10, 10.5, 9.5, 10.2), // stale REST copy of the same bar
    ])
    const merged = candleCache.getCandles(EX, SYM, TF)
    expect(merged?.map(c => c.time)).toEqual([240, 300])
    // Current (authoritative) copy of 300 wins, not the older page's.
    expect(merged?.[1].close).toBe(11.7)
  })

  it('filters invalid candles out of the older page before merging (parity with dedupSort/setCandles)', () => {
    // Stage 2 fix: prependCandles used to skip the validateCandle filter
    // that dedupSort/setCandles apply, letting a malformed API candle slip
    // into the cache silently AND making merged.length disagree with what
    // renderCandles ends up putting in candlesDataRef (which always filters
    // via validateCandle) — the exact mismatch that made the lazy-scroll
    // `added = merged.length - prevLen` viewport-shift calc drift.
    candleCache.setCandles(EX, SYM, TF, [
      makeCandle(300, 10, 11, 9, 10.5),
    ])
    candleCache.prependCandles(EX, SYM, TF, [
      makeCandle(180, 8, 9, 7, 8.5),
      // high < low: invalid OHLC relationship — must be dropped, not merged.
      { ...makeCandle(210, 8.5, 7, 9, 8), time: 210 },
      // negative volume: invalid — must be dropped.
      makeCandle(240, 9, 9.5, 8.5, 9.2, -5),
    ])
    const merged = candleCache.getCandles(EX, SYM, TF)
    expect(merged?.map(c => c.time)).toEqual([180, 300])
  })

  it('no-op on an empty older page (does not touch totalCandleCount bookkeeping)', () => {
    candleCache.setCandles(EX, SYM, TF, [makeCandle(300, 10, 11, 9, 10.5)])
    candleCache.prependCandles(EX, SYM, TF, [])
    expect(candleCache.getCandles(EX, SYM, TF)?.length).toBe(1)
  })

  it('duplicates on the stitch line collapse to one entry (no double-counted length)', () => {
    // Regression guard for the "added" viewport-shift math: prepending a
    // page whose newest candle exactly matches the array's CURRENT oldest
    // candle must not double it — merged.length must reflect the true
    // union, not older.length + current.length.
    candleCache.setCandles(EX, SYM, TF, [
      makeCandle(300, 10, 11, 9, 10.5),
      makeCandle(360, 10.5, 11.5, 10, 11),
    ])
    candleCache.prependCandles(EX, SYM, TF, [
      makeCandle(180, 8, 9, 7, 8.5),
      makeCandle(240, 8.5, 9.5, 8, 9),
      makeCandle(300, 10, 11, 9, 10.5), // exact duplicate of the stitch point
    ])
    const merged = candleCache.getCandles(EX, SYM, TF)
    expect(merged?.map(c => c.time)).toEqual([180, 240, 300, 360])
    expect(merged?.length).toBe(4)
  })
})
