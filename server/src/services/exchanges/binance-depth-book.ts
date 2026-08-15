import type { UnifiedDepth, Exchange } from '../../types.js'

export interface DiffDepthEvent {
  U: number
  u: number
  b: [string, string][]
  a: [string, string][]
}

export type DiffApplyResult = 'applied' | 'buffered' | 'resync'

const MAX_BUFFERED = 5000
const MAX_LEVELS_PER_SIDE = 1500

/**
 * Local orderbook assembled from Binance partial-book-diff events
 * (`<symbol>@depth@100ms`) seeded with a REST snapshot.
 *
 * Standard Binance algorithm: buffer events until the snapshot arrives,
 * drop events with u <= lastUpdateId, apply the rest, and force a resync
 * when a gap is detected (U > lastUpdateId + 1) — the gap check also
 * self-heals after pool reconnects, since the first post-reconnect event
 * usually jumps ahead of the stale lastUpdateId.
 */
export class BinanceDepthBook {
  bids = new Map<number, number>()
  asks = new Map<number, number>()
  lastUpdateId = 0

  private loading = true
  private buffered: DiffDepthEvent[] = []

  get synced(): boolean {
    return !this.loading
  }

  setSnapshot(bids: [number, number][], asks: [number, number][], lastUpdateId: number): void {
    this.bids = new Map(bids)
    this.asks = new Map(asks)
    this.lastUpdateId = lastUpdateId
    this.loading = false
    const pending = this.buffered
    this.buffered = []
    for (const ev of pending) this.applyDiff(ev)
  }

  applyDiff(ev: DiffDepthEvent): DiffApplyResult {
    if (this.loading) {
      if (this.buffered.length < MAX_BUFFERED) this.buffered.push(ev)
      else this.resync()
      return 'buffered'
    }
    if (ev.u <= this.lastUpdateId) return 'buffered'
    if (ev.U > this.lastUpdateId + 1) {
      this.resync()
      return 'resync'
    }
    for (const [p, q] of ev.b) this.applyLevel(this.bids, parseFloat(p), parseFloat(q), 'bid')
    for (const [p, q] of ev.a) this.applyLevel(this.asks, parseFloat(p), parseFloat(q), 'ask')
    this.lastUpdateId = ev.u
    return 'applied'
  }

  resync(): void {
    this.loading = true
    this.lastUpdateId = 0
    this.buffered = []
    this.bids = new Map()
    this.asks = new Map()
  }

  toDepth(symbol: string, exchange: Exchange, limit = 500): UnifiedDepth {
    const bids = Array.from(this.bids.entries())
      .sort((a, b) => b[0] - a[0])
      .slice(0, limit)
    const asks = Array.from(this.asks.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(0, limit)
    return {
      symbol,
      exchange,
      bids,
      asks,
      timestamp: Date.now(),
    }
  }

  private applyLevel(book: Map<number, number>, price: number, qty: number, side: 'bid' | 'ask'): void {
    if (!isFinite(price) || !isFinite(qty) || price <= 0) return
    if (qty === 0) {
      book.delete(price)
      return
    }
    if (!book.has(price) && book.size >= MAX_LEVELS_PER_SIDE) {
      // Evict the level farthest from the top of the book: bids keep the
      // highest prices, asks keep the lowest.
      let evictKey: number | null = null
      for (const key of book.keys()) {
        if (evictKey === null || (side === 'bid' ? key < evictKey : key > evictKey)) evictKey = key
      }
      if (evictKey !== null) book.delete(evictKey)
    }
    book.set(price, qty)
  }
}
