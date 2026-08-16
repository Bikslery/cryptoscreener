import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/ws/hub.js', () => ({
  broadcastToChannel: vi.fn(),
  getChannelSubscriberCount: vi.fn(() => 0),
}))
vi.mock('../src/redis.js', () => ({
  getRedisPub: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(0) })),
  REDIS_ENABLED: false,
}))
vi.mock('../src/services/aggregator/index.js', () => ({
  getTickers: vi.fn(() => []),
}))

import { __test, getDensitySnapshot } from '../src/services/density/index.js'
import { pickInheritCandidate } from '../src/services/density/wall-life.js'
import { broadcastToChannel } from '../src/ws/hub.js'
import type { UnifiedDepth } from '../src/types.js'

const SYM = 'TESTUSDT'
const EX = 'binance-futures' as const

/**
 * Стакан с 8 обычными аск-бакетами (qty → ~ordinary×100 USDT) в окне
 * детекции вне зоны спреда. best ask 100.02 → зона исключения < 100.03.
 */
function askDepth(opts: {
  ordinaryQty?: number
  wallPrice?: number | null
  wallQty?: number
  stackQty?: number
  thin?: boolean
  symbol?: string
}): UnifiedDepth {
  const q = opts.ordinaryQty ?? 1
  const prices = [100.1, 100.2, 100.3, 100.32, 100.44, 100.48, 100.6, 100.7]
  const asks: [number, number][] = []
  if (opts.stackQty !== undefined) asks.push([100.02, opts.stackQty])
  else asks.push([100.02, 10])
  if (!opts.thin) for (const p of prices) asks.push([p, q])
  else for (const p of prices.slice(0, 3)) asks.push([p, q])
  if (opts.wallPrice !== null && opts.wallPrice !== undefined) {
    asks.push([opts.wallPrice, opts.wallQty ?? 12_000])
  }
  const bids: [number, number][] = [
    [99.98, 10],
    [99.9, 1],
  ]
  return { symbol: opts.symbol ?? SYM, exchange: EX, bids, asks, timestamp: Date.now() }
}

function setup(): void {
  __test.reset()
  __test.seedBook(EX, SYM, 100)
}

function askWalls(symbol = SYM) {
  return __test.wallStates().filter(w => w.wall.symbol === symbol && w.wall.side === 'ask')
}

describe('pickInheritCandidate (pure)', () => {
  const cands = [
    { key: 'a', price: 100.4, missedTicks: 1 },
    { key: 'b', price: 100.9, missedTicks: 0 },
    { key: 'c', price: 100.42, missedTicks: 999 },
  ]

  it('picks the nearest wall within tolerance', () => {
    expect(pickInheritCandidate(cands, 100.41, 0.1, 60)).toBe('a')
  })

  it('returns null when nothing is within tolerance', () => {
    expect(pickInheritCandidate(cands, 101.5, 0.1, 60)).toBeNull()
  })

  it('skips candidates beyond the grace window', () => {
    expect(pickInheritCandidate(cands, 100.41, 0.1, 10)).toBe('a')
    expect(pickInheritCandidate(cands, 100.41, 0.1, 0)).toBeNull()
  })
})

describe('density: standout detection (no false walls)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setup()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('detects a wall that stands out from ordinary orders', () => {
    __test.feed(askDepth({ wallPrice: 100.4, wallQty: 12_000 }))
    __test.tick()
    const walls = askWalls()
    expect(walls).toHaveLength(1)
    expect(walls[0].wall.price).toBeCloseTo(100.4, 6)
    expect(walls[0].wall.sizeUsdt).toBeGreaterThan(1_000_000)
    expect(walls[0].wall.bornAt).toBe(Date.now())
    __test.publish()
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(1)
  })

  it('DOGE-style: ordinary clusters and the spread stack are NOT walls, only the spike is', () => {
    // обычные кластеры ~200K, спред-стек 3M (зона исключения), стена 3M.
    __test.feed(askDepth({ ordinaryQty: 2_000, stackQty: 30_000, wallPrice: 100.4, wallQty: 30_000 }))
    __test.tick()
    __test.publish()
    const snap = getDensitySnapshot()
    const sym = snap.walls.filter(w => w.symbol === SYM)
    expect(sym).toHaveLength(1)
    expect(sym[0].price).toBeCloseTo(100.4, 6)
    // порог = 5 × ~200K = ~1M — обычные кластеры 200K не проходят
    expect(snap.autoBrps.find(b => b.symbol === SYM)?.autoBrp ?? 0).toBeGreaterThanOrEqual(1_000_000)
  })

  it('a cluster only 3× ordinary is NOT a wall (needs ≥5×)', () => {
    // обычные 200K, «стена» 600K = 3× — не выделяется.
    __test.feed(askDepth({ ordinaryQty: 2_000, wallPrice: 100.4, wallQty: 6_000 }))
    __test.tick()
    __test.publish()
    expect(askWalls()).toHaveLength(0)
  })

  it('a huge spread stack alone is never a wall', () => {
    __test.feed(askDepth({ ordinaryQty: 2_000, stackQty: 50_000 }))
    __test.tick()
    __test.publish()
    expect(askWalls()).toHaveLength(0)
  })

  it('a uniform book without spikes emits nothing', () => {
    __test.feed(askDepth({ ordinaryQty: 500 }))
    __test.tick()
    __test.publish()
    expect(askWalls()).toHaveLength(0)
  })

  it('a thin book (< MIN_BUCKETS) is skipped entirely', () => {
    __test.feed(askDepth({ thin: true, wallPrice: 100.4, wallQty: 50_000 }))
    __test.tick()
    __test.publish()
    expect(askWalls()).toHaveLength(0)
    expect(getDensitySnapshot().autoBrps.find(b => b.symbol === SYM)?.autoBrp ?? null).toBeNull()
  })

  it('walls do not inflate their own baseline (trimmed median)', () => {
    // 5 стен по 3M + обычные 200K: усечённая медиана остаётся ~200K,
    // порог ~1M — все 5 стен выделяются и детектируются.
    __test.feed(askDepth({ ordinaryQty: 2_000, wallPrice: 100.4, wallQty: 30_000 }))
    __test.tick()
    expect(askWalls()).toHaveLength(1)
    expect(getDensitySnapshot().autoBrps.find(b => b.symbol === SYM)?.autoBrp ?? 0).toBeLessThan(1_500_000)
  })
})

describe('density wall lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setup()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops an eaten wall from the snapshot but keeps its record in grace', () => {
    __test.feed(askDepth({ wallPrice: 100.4 }))
    __test.tick()
    __test.publish()
    const bornAt = askWalls()[0].wall.bornAt
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(1)

    __test.feed(askDepth({ wallPrice: null }))
    __test.tick()
    __test.publish()
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(0)
    const kept = askWalls()
    expect(kept).toHaveLength(1)
    expect(kept[0].missedTicks).toBe(1)
    expect(kept[0].wall.bornAt).toBe(bornAt)
  })

  it('restores the wall with its original bornAt when it returns within grace', () => {
    __test.feed(askDepth({ wallPrice: 100.4 }))
    __test.tick()
    const bornAt = askWalls()[0].wall.bornAt

    __test.feed(askDepth({ wallPrice: null }))
    __test.tick()
    __test.publish()
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(0)

    vi.advanceTimersByTime(5_000)
    __test.feed(askDepth({ wallPrice: 100.4 }))
    __test.tick()
    const walls = askWalls()
    expect(walls).toHaveLength(1)
    expect(walls[0].wall.bornAt).toBe(bornAt)
    expect(walls[0].missedTicks).toBe(0)
    __test.publish()
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(1)
  })

  it('inherits bornAt when the wall migrates to a neighbouring bucket', () => {
    __test.feed(askDepth({ wallPrice: 100.4 }))
    __test.tick()
    const bornAt = askWalls()[0].wall.bornAt
    const oldKey = askWalls()[0].key

    vi.advanceTimersByTime(3_000)
    __test.feed(askDepth({ wallPrice: 100.46 }))
    __test.tick()
    const walls = askWalls()
    expect(walls).toHaveLength(1)
    expect(walls[0].key).not.toBe(oldKey)
    expect(walls[0].wall.price).toBeCloseTo(100.46, 6)
    expect(walls[0].wall.bornAt).toBe(bornAt)
  })

  it('deletes the wall only after the grace window of consecutive misses', () => {
    __test.feed(askDepth({ wallPrice: 100.4 }))
    __test.tick()
    for (let i = 0; i < 60; i++) {
      __test.feed(askDepth({ wallPrice: null }))
      __test.tick()
    }
    expect(askWalls()).toHaveLength(1)
    __test.feed(askDepth({ wallPrice: null }))
    __test.tick()
    expect(askWalls()).toHaveLength(0)
  })

  it('broadcasts an empty snapshot so clients clear stale walls', () => {
    __test.publish()
    expect(broadcastToChannel).toHaveBeenCalledWith(
      'density',
      expect.objectContaining({ walls: [] }),
      true,
    )
  })
})
