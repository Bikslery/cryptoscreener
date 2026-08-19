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
    corrBtc: null,
    tradesSpike: null,
    volumeSpike: null,
    lastClose: null,
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
    watchlist: [],
    pageIndex: 0,
  }
}

describe('mergeTickerBatch', () => {
  it('preserves identity of unchanged coins and replaces changed ones per exchange', () => {
    const futures = t('ETHUSDT', 'binance-futures', 3000)
    const spot = t('ETHUSDT', 'binance-spot', 3001)
    const list = [futures, spot]

    const updatedFutures = t('ETHUSDT', 'binance-futures', 3010)
    const { next, dirty } = mergeTickerBatch(list, [updatedFutures])

    expect(dirty).toBe(true)
    expect(next[0]).not.toBe(futures) // changed futures → new reference
    expect(next[0].price).toBe(3010)
    expect(next[1]).toBe(spot) // spot untouched → same reference
  })

  it('a spot-only update never overwrites the futures entry', () => {
    const futures = t('ETHUSDT', 'binance-futures', 3000, 61800)
    const spot = t('ETHUSDT', 'binance-spot', 3001, 1500)
    const list = [futures, spot]

    const { next } = mergeTickerBatch(list, [t('ETHUSDT', 'binance-spot', 3011, 1510)])
    expect(next[0]).toBe(futures) // futures entry identical → same ref
    expect(next[0].quoteVolume24h).toBe(61800)
    expect(next[1].price).toBe(3011) // only spot updated
  })

  it('returns dirty=false and the same array when nothing changed', () => {
    const a = t('BTCUSDT', 'binance-futures', 50000)
    const { next, dirty } = mergeTickerBatch([a], [t('BTCUSDT', 'binance-futures', 50000)])
    expect(dirty).toBe(false)
    expect(next[0]).toBe(a)
  })

  it('a metric-only change (corrBtc/spikes) still replaces the entry', () => {
    const a = t('ETHUSDT', 'binance-futures', 3000)
    const updated = t('ETHUSDT', 'binance-futures', 3000)
    updated.corrBtc = 0.42
    updated.tradesSpike = 2.5
    updated.volumeSpike = 1.8
    const { next, dirty } = mergeTickerBatch([a], [updated])
    expect(dirty).toBe(true)
    expect(next[0]).not.toBe(a)
    expect(next[0].corrBtc).toBe(0.42)
    expect(next[0].tradesSpike).toBe(2.5)
    expect(next[0].volumeSpike).toBe(1.8)
  })

  it('identical indicator values keep the entry reference', () => {
    const a = t('BTCUSDT', 'binance-futures', 50000)
    a.corrBtc = 0.99
    a.tradesSpike = null
    const updated = t('BTCUSDT', 'binance-futures', 50000)
    updated.corrBtc = 0.99
    updated.tradesSpike = null
    const { next, dirty } = mergeTickerBatch([a], [updated])
    expect(dirty).toBe(false)
    expect(next[0]).toBe(a)
  })

  it('appends brand-new (symbol, exchange) pairs and marks dirty', () => {
    const a = t('BTCUSDT', 'binance-futures', 50000)
    const { next, dirty } = mergeTickerBatch([a], [t('NEWUSDT', 'binance-futures', 5, 42)])
    expect(dirty).toBe(true)
    expect(next).toHaveLength(2)
    expect(next[1].symbol).toBe('NEWUSDT')
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

  it('delta merges per exchange and keeps coinMap on the highest-priority entry', () => {
    const futures = t('ETHUSDT', 'binance-futures', 3000, 61800)
    const spot = t('ETHUSDT', 'binance-spot', 3001, 1500)
    const s = state([futures, spot])

    // Only the SPOT side changed in this delta — the futures entry must stay
    // intact and coinMap must still resolve ETH to futures (priority 5 > 2).
    const patch = applyTickerFrame(s, [t('ETHUSDT', 'binance-spot', 3011, 1510)], true)

    expect(patch.coins).toHaveLength(2)
    expect(patch.coins?.[0]).toBe(futures) // untouched ref
    expect(patch.coins?.[1]?.price).toBe(3011)
    expect(patch.coinMap?.get('ETHUSDT')?.exchange).toBe('binance-futures')
    expect(patch.coinMap?.get('ETHUSDT')?.quoteVolume24h).toBe(61800)
    expect(patch.pageIndex).toBeUndefined() // delta never touches pagination
  })

  it('delta with a brand-new symbol appends it and exposes it via coinMap', () => {
    const a = t('AAAUSDT', 'binance-futures', 1, 1000)
    const s = state([a])
    const patch = applyTickerFrame(s, [t('NEWUSDT', 'binance-futures', 5, 42)], true)
    expect(patch.coins).toHaveLength(2)
    expect(patch.sortedCoins?.some(c => c.symbol === 'NEWUSDT')).toBe(true)
    expect(patch.coinMap?.get('NEWUSDT')?.price).toBe(5)
  })

  it('snapshot pins watchlist symbols to the top, sorted by the active column', () => {
    const s = { ...state([]), watchlist: ['CCCUSDT'] }
    const snapshot = [
      t('AAAUSDT', 'binance-futures', 1, 1000),
      t('BBBUSDT', 'binance-futures', 2, 500),
      t('CCCUSDT', 'binance-futures', 3, 100),
      t('DDDUSDT', 'binance-futures', 4, 10),
    ]
    const patch = applyTickerFrame(s, snapshot, false)
    const symbols = (patch.sortedCoins ?? []).map(c => c.symbol)
    // CCC is watched → pinned to the top; the rest keep volume-desc order.
    expect(symbols[0]).toBe('CCCUSDT')
    expect(symbols.slice(1)).toEqual(['AAAUSDT', 'BBBUSDT', 'DDDUSDT'])
  })

  it('pinned group itself follows the sort criteria (not insertion order)', () => {
    const s = { ...state([]), watchlist: ['ZZZUSDT', 'AAAUSDT'] }
    const snapshot = [
      t('AAAUSDT', 'binance-futures', 1, 1000),
      t('ZZZUSDT', 'binance-futures', 2, 2000),
      t('BBBUSDT', 'binance-futures', 3, 100),
    ]
    const patch = applyTickerFrame(s, snapshot, false)
    const symbols = (patch.sortedCoins ?? []).map(c => c.symbol)
    // Both pinned; among them volume desc → ZZZ (2000) before AAA (1000).
    expect(symbols.slice(0, 2)).toEqual(['ZZZUSDT', 'AAAUSDT'])
    expect(symbols[2]).toBe('BBBUSDT')
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
