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
