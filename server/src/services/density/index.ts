import type { ExchangeAdapter, DepthCallback } from '../exchanges/types.js'
import type { Exchange, UnifiedDepth, DensityWall, DensitySnapshot } from '../../types.js'
import { getTickers } from '../aggregator/index.js'
import { broadcastToChannel, getChannelSubscriberCount } from '../../ws/hub.js'
import { getRedisPub, REDIS_ENABLED } from '../../redis.js'
import { pickInheritCandidate, type InheritCandidate } from './wall-life.js'

// --- Density engine -------------------------------------------------------
// Every DENSITY_TICK_MS per symbol the current book state is clustered into
// 0.05% price buckets on an ABSOLUTE price grid (a real wall keeps its
// bucket while the price moves). Local maxima above the base threshold are
// "walls" (плотности); their bornAt is the first tick they crossed the
// threshold. The server broadcasts a neutral snapshot (sizes + bornAt +
// roundNumber + per-symbol auto БРП) — category thresholds are personal
// settings and are applied CLIENT-side.

const TOP_N = parseInt(process.env.DENSITY_TOP_N || '300', 10)
const TICK_MS = parseInt(process.env.DENSITY_TICK_MS || '250', 10)
const TICK_SLICES = parseInt(process.env.DENSITY_TICK_SLICES || '10', 10)
const BROADCAST_MS = parseInt(process.env.DENSITY_BROADCAST_MS || '2000', 10)
const RESCAN_MS = parseInt(process.env.DENSITY_RESCAN_MS || '60000', 10)
const STEP_PCT = parseFloat(process.env.DENSITY_STEP_PCT || '0.0005')
const TOP_K_PER_SIDE = parseInt(process.env.DENSITY_TOP_K || '5', 10)
const CAP_WALLS = parseInt(process.env.DENSITY_CAP || '1000', 10)
// scalpboard parity: БРП fallback 500K, minimum multiplier ×2 (their small
// tier) — anything below 2×БРП is an ordinary order, not a density.
const DEFAULT_BRP = parseFloat(process.env.DENSITY_DEFAULT_BRP || '500000')
const MIN_MULT = parseFloat(process.env.DENSITY_MIN_MULT || '2')
const WALL_GRACE_MS = parseInt(process.env.DENSITY_WALL_GRACE_MS || '15000', 10)
const WALL_GRACE_TICKS = Math.max(2, Math.ceil(WALL_GRACE_MS / TICK_MS))
const MATCH_TOL_PCT = parseFloat(process.env.DENSITY_MATCH_TOL || '0.1')

interface BookState {
  exchange: Exchange
  symbol: string
  bids: Map<number, number>
  asks: Map<number, number>
  mid: number
  dirty: boolean
  /** per-coin БРП from the coin's 24h traded volume (scalpboard auto mode) */
  brp: number | null
}

interface WallState {
  wall: DensityWall
  /** consecutive symbol-ticks without seeing the wall; 0 = seen at its last tick */
  missedTicks: number
}

const books = new Map<string, BookState>()
const walls = new Map<string, WallState>()
const subscribed = new Set<string>()

let tickCounter = 0
let sliceTimer: ReturnType<typeof setInterval> | null = null
let rescanTimer: ReturnType<typeof setTimeout> | null = null
let broadcastTimer: ReturnType<typeof setInterval> | null = null
let lastSnapshot: DensitySnapshot = { ts: 0, walls: [], autoBrps: [] }

const key = (exchange: Exchange, symbol: string) => `${exchange}:${symbol}`

function isRoundPrice(price: number): boolean {
  if (!isFinite(price) || price <= 0) return false
  const k = Math.floor(Math.log10(price)) - 2
  const div = Math.pow(10, k)
  const v = price / div
  return Math.abs(v - Math.round(v)) < 1e-9
}


// scalpboard's auto-БРП is "рассчитывается на основе проторгованных объёмов"
// (their docs): the per-coin base density size is a fraction of the coin's
// 24h traded volume, clamped. Popular coins (BTC/ETH/…) therefore get much
// higher thresholds than small caps automatically — the "separate setting"
// per coin — and no warmup is needed: the value is ready at boot.
const BRP_VOL_DIV = parseFloat(process.env.DENSITY_BRP_VOLUME_DIV || '3000')
const BRP_MIN = parseFloat(process.env.DENSITY_BRP_MIN || '50000')
const BRP_MAX = parseFloat(process.env.DENSITY_BRP_MAX || '25000000')

function volumeBrp(quoteVolume24h: number | undefined | null): number | null {
  if (!quoteVolume24h || !isFinite(quoteVolume24h) || quoteVolume24h <= 0) return null
  return Math.min(BRP_MAX, Math.max(BRP_MIN, quoteVolume24h / BRP_VOL_DIV))
}

/** Per-coin БРП from the book's volume-derived value; null = DEFAULT_BRP. */
function effectiveAutoBrp(exchange: Exchange, symbol: string): number | null {
  return books.get(key(exchange, symbol))?.brp ?? null
}

function onDepth(depth: UnifiedDepth): void {
  const k = key(depth.exchange, depth.symbol)
  const existing = books.get(k)
  if (!existing) return
  existing.bids = new Map(depth.bids)
  existing.asks = new Map(depth.asks)
  const bestBid = depth.bids[0]?.[0]
  const bestAsk = depth.asks[0]?.[0]
  if (bestBid && bestAsk && bestBid > 0 && bestAsk > 0) {
    existing.mid = (bestBid + bestAsk) / 2
  }
  existing.dirty = true
}

function clusterSide(
  levels: Map<number, number>,
  step: number,
): Map<number, { size: number; maxPrice: number; maxSize: number }> {
  const buckets = new Map<number, { size: number; maxPrice: number; maxSize: number }>()
  for (const [price, qty] of levels) {
    const idx = Math.floor(price / step)
    const size = qty * price
    let bucket = buckets.get(idx)
    if (!bucket) {
      bucket = { size: 0, maxPrice: price, maxSize: qty }
      buckets.set(idx, bucket)
    }
    bucket.size += size
    if (qty > bucket.maxSize) {
      bucket.maxSize = qty
      bucket.maxPrice = price
    }
  }
  return buckets
}

/** Local maxima (strictly larger than both neighbours) above threshold. */
function detectWalls(
  buckets: Map<number, { size: number; maxPrice: number; maxSize: number }>,
  threshold: number,
  topK: number,
): { idx: number; size: number; price: number }[] {
  const idxs = Array.from(buckets.keys()).sort((a, b) => a - b)
  const found: { idx: number; size: number; price: number }[] = []
  for (let i = 0; i < idxs.length; i++) {
    const idx = idxs[i]
    const bucket = buckets.get(idx)!
    if (bucket.size < threshold) continue
    const left = i > 0 ? buckets.get(idxs[i - 1]) : undefined
    const right = i < idxs.length - 1 ? buckets.get(idxs[i + 1]) : undefined
    if (left && left.size >= bucket.size) continue
    if (right && right.size >= bucket.size) continue
    found.push({ idx, size: bucket.size, price: bucket.maxPrice })
  }
  found.sort((a, b) => b.size - a.size)
  return found.slice(0, topK)
}

function tickBook(state: BookState): void {
  state.dirty = false
  const mid = state.mid
  if (mid <= 0) return
  const step = mid * STEP_PCT
  if (step <= 0) return

  const k = key(state.exchange, state.symbol)
  const autoBrp = effectiveAutoBrp(state.exchange, state.symbol)
  const threshold = (autoBrp ?? DEFAULT_BRP) * MIN_MULT

  const bidBuckets = clusterSide(state.bids, step)
  const askBuckets = clusterSide(state.asks, step)

  const bidWalls = detectWalls(bidBuckets, threshold, TOP_K_PER_SIDE)
  const askWalls = detectWalls(askBuckets, threshold, TOP_K_PER_SIDE)

  const seen = new Set<string>()
  for (const side of ['bid', 'ask'] as const) {
    for (const w of side === 'bid' ? bidWalls : askWalls) {
      const wk = `${k}:${side}:${w.idx}`
      if (seen.has(wk)) continue
      seen.add(wk)
      const existing = walls.get(wk)
      if (existing) {
        existing.missedTicks = 0
        existing.wall.sizeUsdt = w.size
        existing.wall.price = w.price
        continue
      }
      // The bucket grid is absolute (step = mid * STEP_PCT), so a moving mid
      // re-buckets the SAME wall into a neighbouring idx. Inherit the nearby
      // wall's identity (bornAt) instead of rebirthing it.
      const prefix = `${k}:${side}:`
      const candidates: InheritCandidate[] = []
      for (const [ok, os] of walls) {
        if (!ok.startsWith(prefix)) continue
        if (seen.has(ok)) continue
        candidates.push({ key: ok, price: os.wall.price, missedTicks: os.missedTicks })
      }
      const inheritKey = pickInheritCandidate(candidates, w.price, MATCH_TOL_PCT, WALL_GRACE_TICKS)
      if (inheritKey !== null) {
        const inherited = walls.get(inheritKey)!
        walls.delete(inheritKey)
        inherited.missedTicks = 0
        inherited.wall.sizeUsdt = w.size
        inherited.wall.price = w.price
        inherited.wall.roundNumber = isRoundPrice(w.price)
        walls.set(wk, inherited)
        continue
      }
      walls.set(wk, {
        wall: {
          symbol: state.symbol,
          exchange: state.exchange,
          side,
          price: w.price,
          sizeUsdt: w.size,
          bornAt: Date.now(),
          roundNumber: isRoundPrice(w.price),
        },
        missedTicks: 0,
      })
    }
  }
  // Age out unseen walls: the record (and its bornAt) survives the grace
  // window so a briefly-flickering wall keeps its duration, and is deleted
  // only after WALL_GRACE_TICKS consecutive misses.
  for (const [wk, ws] of walls) {
    if (!wk.startsWith(k + ':')) continue
    if (seen.has(wk)) continue
    ws.missedTicks++
    if (ws.missedTicks > WALL_GRACE_TICKS) walls.delete(wk)
  }
}

function rescanSymbols(adapters: ExchangeAdapter[]): void {
  const depthAdapters = adapters.filter(a => typeof a.subscribeDepth === 'function')
  const top = getTickers()
    .slice()
    .sort((a, b) => (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0))
    .slice(0, TOP_N)
  const wanted = new Set<string>()
  const cb: DepthCallback = onDepth

  for (const ticker of top) {
    // scalpboard auto mode: per-coin БРП from the coin's 24h traded volume.
    const brp = volumeBrp(ticker.quoteVolume24h)
    for (const adapter of depthAdapters) {
      const k = key(adapter.exchange, ticker.symbol)
      wanted.add(k)
      if (subscribed.has(k)) {
        books.get(k)!.brp = brp
        continue
      }
      subscribed.add(k)
      books.set(k, { exchange: adapter.exchange, symbol: ticker.symbol, bids: new Map(), asks: new Map(), mid: ticker.price, dirty: true, brp })
      adapter.subscribeDepth(ticker.symbol, cb)
    }
  }

  for (const k of Array.from(subscribed)) {
    if (wanted.has(k)) continue
    subscribed.delete(k)
    books.delete(k)
    for (const [wk] of walls) {
      if (wk.startsWith(k + ':')) walls.delete(wk)
    }
    const [exchange, symbol] = k.split(':')
    const adapter = depthAdapters.find(a => a.exchange === exchange)
    adapter?.unsubscribeDepth(symbol, cb)
  }

  console.log(`[Density] top=${top.length} subscribed=${subscribed.size} adapters=${depthAdapters.length}`)
}

function buildSnapshot(): DensitySnapshot {
  // Only walls seen at their symbol's latest tick are broadcast: an eaten
  // wall must vanish from the chart immediately, while it lingers in the
  // walls map through its grace window to keep bornAt.
  const all = []
  for (const ws of walls.values()) {
    if (ws.missedTicks > 0) continue
    all.push(ws.wall)
  }
  all.sort((a, b) => b.sizeUsdt - a.sizeUsdt)
  const capped = all.slice(0, CAP_WALLS)
  // Report БРП for every live book (not only warmed rings): the effective
  // value includes cross-exchange borrowing, so a venue whose books are
  // still syncing still gets real per-symbol thresholds on the client.
  const autoBrps = Array.from(books.values()).map((state) => ({
    symbol: state.symbol,
    exchange: state.exchange,
    autoBrp: effectiveAutoBrp(state.exchange, state.symbol),
  }))
  return { ts: Date.now(), walls: capped, autoBrps }
}

function publishSnapshot(): void {
  lastSnapshot = buildSnapshot()
  // Broadcast even when empty: clients must clear walls that disappeared,
  // otherwise they would keep rendering stale densities forever.
  broadcastToChannel('density', lastSnapshot, true)
  if (lastSnapshot.walls.length > 0) {
    console.log(`[Density] publish walls=${lastSnapshot.walls.length} wsClients=${getChannelSubscriberCount('density')}`)
  }
  if (REDIS_ENABLED) {
    try {
      getRedisPub().publish('density', JSON.stringify(lastSnapshot)).catch(() => {})
    } catch { /* redis down */ }
  }
}

function scheduleRescan(adapters: ExchangeAdapter[]): void {
  // While no tickers are available yet (aggregator still warming up), retry
  // every 10s; once we hold the top-N set, rescan on the regular cadence.
  const delay = books.size === 0 ? 10_000 : RESCAN_MS
  rescanTimer = setTimeout(() => {
    rescanSymbols(adapters)
    scheduleRescan(adapters)
  }, delay)
}

export function startDensityService(adapters: ExchangeAdapter[]): void {
  rescanSymbols(adapters)
  scheduleRescan(adapters)

  // Phased per-symbol ticks: 1/TICK_SLICES of the books every slice keeps
  // the CPU spread instead of one giant synchronous burst.
  const sliceMs = Math.max(10, Math.floor(TICK_MS / TICK_SLICES))
  sliceTimer = setInterval(() => {
    const keys = Array.from(books.keys())
    const sliceSize = Math.max(1, Math.ceil(keys.length / TICK_SLICES))
    const sliceIdx = tickCounter % TICK_SLICES
    const slice = keys.slice(sliceIdx * sliceSize, (sliceIdx + 1) * sliceSize)
    for (const k of slice) {
      const state = books.get(k)
      if (state && state.dirty) tickBook(state)
    }
    if (sliceIdx === TICK_SLICES - 1) tickCounter++
  }, sliceMs)

  broadcastTimer = setInterval(publishSnapshot, BROADCAST_MS)

  // Ops visibility: one compact line per minute.
  setInterval(() => {
    const st = getDensityStats()
    let nonEmpty = 0
    for (const state of books.values()) {
      if (state.bids.size > 0 || state.asks.size > 0) nonEmpty++
    }
    console.log(`[Density] stats books=${st.books} (nonEmpty=${nonEmpty}) subscribed=${st.subscribed} walls=${st.walls} snapshotWalls=${st.snapshotWalls}`)
  }, 60_000)

  console.log(`[Density] started: topN=${TOP_N} tick=${TICK_MS}ms broadcast=${BROADCAST_MS}ms stepPct=${STEP_PCT}`)
}

export function stopDensityService(): void {
  if (sliceTimer) { clearInterval(sliceTimer); sliceTimer = null }
  if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null }
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
}

export function getDensitySnapshot(limit = 500): DensitySnapshot {
  const snap = lastSnapshot
  return { ts: snap.ts, walls: snap.walls.slice(0, limit), autoBrps: snap.autoBrps }
}

export function getDensityStats() {
  return {
    books: books.size,
    subscribed: subscribed.size,
    walls: walls.size,
    snapshotWalls: lastSnapshot.walls.length,
    snapshotTs: lastSnapshot.ts,
  }
}

/** Direct access to the engine's internals for tests (no timers, no IO). */
export const __test = {
  reset(): void {
    books.clear()
    walls.clear()
    subscribed.clear()
    tickCounter = 0
    lastSnapshot = { ts: 0, walls: [], autoBrps: [] }
  },
  seedBook(exchange: Exchange, symbol: string, mid: number, brp?: number): void {
    books.set(key(exchange, symbol), { exchange, symbol, bids: new Map(), asks: new Map(), mid, dirty: true, brp: brp ?? null })
  },
  feed(depth: UnifiedDepth): void {
    onDepth(depth)
  },
  /** One full pass: tick every dirty book once (like one engine cycle). */
  tick(): void {
    for (const state of books.values()) {
      if (state.dirty) tickBook(state)
    }
  },
  /** All wall records incl. grace ones: [key, wall, missedTicks]. */
  wallStates(): { key: string; wall: DensityWall; missedTicks: number }[] {
    return Array.from(walls.entries()).map(([key, ws]) => ({ key, wall: ws.wall, missedTicks: ws.missedTicks }))
  },
  publish(): void {
    publishSnapshot()
  },
}
