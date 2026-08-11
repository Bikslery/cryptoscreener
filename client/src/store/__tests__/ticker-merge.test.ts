import { describe, it, expect } from 'vitest'
import { mergeTickerBatch, applyTickerFrame } from '../index'
import type { Exchange, UnifiedTicker } from '../../types'

function t(symbol: string, exchange: Exchange, price: number, quoteVolume24h = 100): UnifiedTicker {
  return {
    symbol,
    exchange,
    price,
    change24h: 0,
    high24h: price,
    low24h: price,
    volume24h: 0,
    trades24h: 0,
    quoteVolume24h,
    range1m: 0,
    natr5m: 0,
    pricePrecision: 2,
    timestamp: 0,
  }
}

type FrameState = Parameters<typeof applyTickerFrame>[0]

function state(coins: UnifiedTicker[]): FrameState {
  return {
    coins,
    sortedCoins: [...coins],
    coinMap: new Map(coins.map(c => [c.symbol, c])),
    autoRefresh: true,
    sortBy: 'quoteVolume24h',
    sortDir: 'desc',
    chartExchange: 'binance-futures',
    minVolume24h: 0,
    pageIndex: 0,
  }
}

describe('mergeTickerBatch', () => {
  it('preserves identity of unchanged coins and replaces changed ones', () => {
    const a = t('BTCUSDT', 'binance-futures', 50000)
    const b = t('ETHUSDT', 'binance-futures', 3000)
    const list = [a, b]

    const updated = t('ETHUSDT', 'binance-futures', 3010)
    const { next, dirty } = mergeTickerBatch(list, [updated])

    expect(dirty).toBe(true)
    expect(next[0]).toBe(a) // unchanged → same reference
    expect(next[1]).not.toBe(b) // changed → new reference
    expect(next[1].price).toBe(3010)
  })

  it('returns dirty=false and the same array when nothing changed', () => {
    const a = t('BTCUSDT', 'binance-futures', 50000)
    const { next, dirty } = mergeTickerBatch([a], [t('BTCUSDT', 'binance-futures', 50000)])
    expect(dirty).toBe(false)
    expect(next[0]).toBe(a)
  })

  it('dedups by symbol keeping the highest-priority exchange', () => {
    const spot = t('BTCUSDT', 'binance-spot', 50000, 1)
    const futures = t('BTCUSDT', 'binance-futures', 50001, 999)
    const list = [t('ETHUSDT', 'binance-futures', 3000)]
    const { next } = mergeTickerBatch(list, [spot, futures])
    // Only BTCUSDT in the delta gets merged — futures wins over spot
    expect(next).toHaveLength(1)
    expect(next[0].symbol).toBe('ETHUSDT')
    const merged = mergeTickerBatch([spot], [futures, spot])
    expect(merged.next[0].exchange).toBe('binance-futures')
    expect(merged.next[0].price).toBe(50001)
  })
})

describe('applyTickerFrame', () => {
  it('snapshot replaces the list and recomputes sort/pageCount', () => {
    const s = state([t('BTCUSDT', 'binance-futures', 50000, 10)])
    const snapshot = [
      t('AAAUSDT', 'binance-futures', 1, 1000),
      t('BBBUSDT', 'binance-futures', 2, 500),
      t('CCCUSDT', 'binance-futures', 3, 100),
    ]
    const patch = applyTickerFrame({ ...s, pageIndex: 5 }, snapshot, false) // snapshot
    expect(patch.coins).toHaveLength(3)
    // recompute clamps pageIndex to a valid page
    expect(patch.pageIndex).toBe(0)
    expect(patch.sortedCoins?.[0].symbol).toBe('AAAUSDT') // highest volume first
    expect(patch.coinMap?.get('CCCUSDT')?.price).toBe(3)
  })

  it('delta merges in place without re-sorting or dropping other coins', () => {
    const a = t('AAAUSDT', 'binance-futures', 1, 1000)
    const b = t('BBBUSDT', 'binance-futures', 2, 500)
    const s = state([a, b])
    const delta = [t('BBBUSDT', 'binance-futures', 2.5, 500)]

    const patch = applyTickerFrame(s, delta, true) // delta
    expect(patch.coins).toHaveLength(2)
    expect(patch.coins?.[0]).toBe(a) // unchanged ref preserved
    expect(patch.sortedCoins?.[0]).toBe(a) // no re-sort (order untouched)
    expect(patch.sortedCoins?.[1]?.price).toBe(2.5)
    expect(patch.pageIndex).toBeUndefined() // delta never touches pagination
  })

  it('delta with only a brand-new symbol is a no-op — the snapshot settles it into lists', () => {
    const s = state([t('AAAUSDT', 'binance-futures', 1, 1000)])
    const delta = [t('NEWUSDT', 'binance-futures', 5, 42)]
    const patch = applyTickerFrame(s, delta, true)
    // Nothing existing changed → empty patch; the periodic snapshot (2s) adds
    // the listing to coins/sortedCoins/coinMap in one consistent replace.
    expect(Object.keys(patch)).toHaveLength(0)
  })

  it('with autoRefresh off, patches prices but never re-sorts', () => {
    const a = t('AAAUSDT', 'binance-futures', 1, 1000)
    const b = t('BBBUSDT', 'binance-futures', 2, 500)
    const s = { ...state([b, a]), autoRefresh: false }
    const patch = applyTickerFrame(s, [t('AAAUSDT', 'binance-futures', 9, 1000)], true)
    expect(patch.coins?.[0]).toBe(b)
    expect(patch.coins?.[1]?.price).toBe(9)
    expect(patch.sortedCoins?.[1]?.price).toBe(9)
    expect(patch.sortedCoins?.[0]).toBe(b) // order frozen
    expect(patch.pageIndex).toBeUndefined()
  })

  it('returns an empty patch when a delta changes nothing', () => {
    const a = t('AAAUSDT', 'binance-futures', 1, 1000)
    const s = state([a])
    const patch = applyTickerFrame(s, [t('AAAUSDT', 'binance-futures', 1, 1000)], true)
    expect(Object.keys(patch)).toHaveLength(0)
  })
})
