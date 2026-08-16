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

/** Asks with a big wall at `wallPrice` (qty 12000 → ~1.2M USDT > 1M = 2×БРП 500K). */
function askDepth(wallPrice: number | null): UnifiedDepth {
  const asks: [number, number][] = [
    [100.02, 10],
    [100.1, 1],
    [100.32, 1],
    [100.48, 1],
  ]
  if (wallPrice !== null) asks.push([wallPrice, 12000])
  const bids: [number, number][] = [
    [99.98, 10],
    [99.9, 1],
  ]
  return { symbol: SYM, exchange: EX, bids, asks, timestamp: Date.now() }
}

function setup(): void {
  __test.reset()
  __test.seedBook(EX, SYM, 100)
}

function askWalls() {
  return __test.wallStates().filter(w => w.wall.side === 'ask')
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
    // 100.42 is nearest to 100.41 but expired; 100.4 must win instead
    expect(pickInheritCandidate(cands, 100.41, 0.1, 10)).toBe('a')
    // everything expired → nothing to inherit
    expect(pickInheritCandidate(cands, 100.41, 0.1, 0)).toBeNull()
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

  it('births a wall above threshold and broadcasts it', () => {
    __test.feed(askDepth(100.4))
    __test.tick()
    const walls = askWalls()
    expect(walls).toHaveLength(1)
    expect(walls[0].wall.price).toBeCloseTo(100.4, 6)
    expect(walls[0].wall.sizeUsdt).toBeGreaterThan(1_000_000)
    expect(walls[0].wall.bornAt).toBe(Date.now())

    __test.publish()
    const snap = getDensitySnapshot()
    expect(snap.walls.filter(w => w.side === 'ask')).toHaveLength(1)
  })

  it('drops an eaten wall from the snapshot but keeps its record in grace', () => {
    __test.feed(askDepth(100.4))
    __test.tick()
    __test.publish()
    const bornAt = askWalls()[0].wall.bornAt
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(1)

    // The wall is gone from the book → excluded from the snapshot at once…
    __test.feed(askDepth(null))
    __test.tick()
    __test.publish()
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(0)
    // …but its record (with bornAt) survives the grace window.
    const kept = askWalls()
    expect(kept).toHaveLength(1)
    expect(kept[0].missedTicks).toBe(1)
    expect(kept[0].wall.bornAt).toBe(bornAt)
  })

  it('restores the wall with its original bornAt when it returns within grace', () => {
    __test.feed(askDepth(100.4))
    __test.tick()
    const bornAt = askWalls()[0].wall.bornAt

    __test.feed(askDepth(null))
    __test.tick()
    __test.publish()
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(0)

    vi.advanceTimersByTime(5_000)
    __test.feed(askDepth(100.4))
    __test.tick()
    const walls = askWalls()
    expect(walls).toHaveLength(1)
    expect(walls[0].wall.bornAt).toBe(bornAt)
    expect(walls[0].missedTicks).toBe(0)

    __test.publish()
    expect(getDensitySnapshot().walls.filter(w => w.side === 'ask')).toHaveLength(1)
  })

  it('inherits bornAt when the wall migrates to a neighbouring bucket', () => {
    __test.feed(askDepth(100.4))
    __test.tick()
    const bornAt = askWalls()[0].wall.bornAt
    const oldKey = askWalls()[0].key

    // 100.4 → 100.46: |Δ|/min ≈ 0.06% ≤ 0.1% tolerance, but a different
    // bucket idx on the mid-anchored grid (floor(100.46/0.05) ≠ floor(100.4/0.05)).
    vi.advanceTimersByTime(3_000)
    __test.feed(askDepth(100.46))
    __test.tick()

    const walls = askWalls()
    expect(walls).toHaveLength(1)
    expect(walls[0].key).not.toBe(oldKey)
    expect(walls[0].wall.price).toBeCloseTo(100.46, 6)
    expect(walls[0].wall.bornAt).toBe(bornAt)
  })

  it('deletes the wall only after the grace window of consecutive misses', () => {
    __test.feed(askDepth(100.4))
    __test.tick()

    // WALL_GRACE_TICKS = ceil(15000 / 250) = 60 missed symbol-ticks.
    for (let i = 0; i < 60; i++) {
      __test.feed(askDepth(null))
      __test.tick()
    }
    expect(askWalls()).toHaveLength(1)

    __test.feed(askDepth(null))
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

  it('borrows БРП across exchanges while a venue\'s ring warms up', () => {
    __test.seedBook('binance-futures', 'ETHUSDT', 2500)
    __test.publish()
    // Своего кольца нет → null → клиент свалился бы на плоский фоллбэк.
    let snap = getDensitySnapshot()
    expect(snap.autoBrps.find(b => b.exchange === 'binance-futures' && b.symbol === 'ETHUSDT')?.autoBrp ?? null).toBeNull()

    // Появилось значение другой биржи для того же символа → фьючерсы
    // заимствуют его, и «обычные заявки» не проходят как плотности.
    __test.setStartupBrps({ 'binance-spot:ETHUSDT': 5_020_000 })
    __test.publish()
    snap = getDensitySnapshot()
    expect(snap.autoBrps.find(b => b.exchange === 'binance-futures' && b.symbol === 'ETHUSDT')?.autoBrp).toBe(5_020_000)
  })
})
