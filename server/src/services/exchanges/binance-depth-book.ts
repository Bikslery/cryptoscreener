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
 * The REST snapshot's lastUpdateId LAGS the live stream (a few thousand
 * update ids on fast books), so the first post-snapshot event can show a
 * gap (U > lastUpdateId + 1). The canonical Binance fix: keep buffering
 * events, re-fetch the snapshot, and apply the buffer once the tick that
 * straddles the new lastUpdateId is found. Clearing the buffer on a gap
 * (the naive approach) loses that straddling tick and loops forever.
 */
export class BinanceDepthBook {
  bids = new Map<number, number>()
  asks = new Map<number, number>()
  lastUpdateId = 0

  private loading = true
  private buffered: DiffDepthEvent[] = []
  private diag = { gaps: 0, applies: 0, lastLog: 0 }

  get synced(): boolean {
    return !this.loading
  }

  setSnapshot(bids: [number, number][], asks: [number, number][], lastUpdateId: number): void {
    this.bids = new Map(bids)
    this.asks = new Map(asks)
    this.lastUpdateId = lastUpdateId
    this.loading = false
    this.drainBuffer()
    if (this.diag.lastLog === 0 || Date.now() - this.diag.lastLog > 60_000) {
      this.diag.lastLog = Date.now()
      console.log(`[DepthBook] snapshot lid=${lastUpdateId} synced=${!this.loading} buf=${this.buffered.length} gaps=${this.diag.gaps} applies=${this.diag.applies}`)
    }
  }

  applyDiff(ev: DiffDepthEvent): DiffApplyResult {
    if (this.loading) {
      // Keep the NEWEST events (the oldest are stale after the snapshot lag):
      // shift the oldest out when the buffer is full.
      this.buffered.push(ev)
      if (this.buffered.length > MAX_BUFFERED) this.buffered.shift()
      return 'buffered'
    }
    if (ev.u <= this.lastUpdateId) return 'buffered'
    if (ev.U > this.lastUpdateId + 1) {
      // The straddling tick was missed (snapshot behind the stream) — keep
      // the current levels, go back to buffering and re-seed from REST.
      this.loading = true
      return 'resync'
    }
    this.applyLevels(ev)
    this.lastUpdateId = ev.u
    return 'applied'
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

  /** Replay buffered events after a snapshot: drop stale (u <= lastUpdateId),
   *  then the first event must straddle the snapshot id — apply it and the
   *  rest. If the buffer starts AFTER the straddling tick (gap), stay in
   *  loading mode and wait for a fresher snapshot instead of clearing. */
  private drainBuffer(): void {
    while (this.buffered.length > 0) {
      const ev = this.buffered[0]
      if (ev.u <= this.lastUpdateId) {
        this.buffered.shift()
        continue
      }
      if (ev.U > this.lastUpdateId + 1) {
        this.loading = true
        this.diag.gaps++
        if (this.diag.gaps <= 3) {
          console.log(`[DepthBook] drain gap lid=${this.lastUpdateId} firstU=${ev.U} firstu=${ev.u} buf=${this.buffered.length}`)
        }
        return
      }
      this.diag.applies++
      while (this.buffered.length > 0) {
        const e = this.buffered.shift()!
        this.applyLevels(e)
        this.lastUpdateId = e.u
      }
      return
    }
  }

  private applyLevels(ev: DiffDepthEvent): void {
    for (const [p, q] of ev.b) this.applyLevel(this.bids, parseFloat(p), parseFloat(q), 'bid')
    for (const [p, q] of ev.a) this.applyLevel(this.asks, parseFloat(p), parseFloat(q), 'ask')
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
