import type { ExchangeAdapter, DepthCallback } from '../exchanges/types.js'
import type { Exchange, UnifiedDepth, DensityWall, DensitySnapshot } from '../../types.js'
import { getTickers } from '../aggregator/index.js'
import { broadcastToChannel, getChannelSubscriberCount } from '../../ws/hub.js'
import { getRedisPub, REDIS_ENABLED } from '../../redis.js'
import { pickInheritCandidate, type InheritCandidate } from './wall-life.js'

// --- Density engine -------------------------------------------------------
// Every DENSITY_TICK_MS per symbol the current book state is clustered into
// 0.05% price buckets on an ABSOLUTE price grid (a real wall keeps its
// bucket while the price moves). A wall («плотность») is a LOCAL MAXIMUM
// that stands out from the coin's own ordinary orders:
//
//   threshold = max(STANDOUT × ordinary_scale, BRP_FLOOR)
//
// where ordinary_scale is the TRIMMED MEDIAN bucket size in the ±WINDOW_PCT
// window (top 10% of buckets dropped — walls and the spread stack cannot
// inflate their own baseline), computed fresh from the live book every tick:
// no warmup, no persisted state, no restart artifacts. The top-of-book
// exclusion zone (±SPREAD_EXCL_PCT from the best price) keeps the ordinary
// spread stack out of candidacy entirely. Thin books (< MIN_BUCKETS) are
// skipped — a half-seeded book must not emit garbage.
//
// The broadcast snapshot carries the per-symbol threshold as БРП; the
// ×2/×3.5/×5 tiering is a CLIENT-side personal setting (scalpboard calcTier).

const TOP_N = parseInt(process.env.DENSITY_TOP_N || '300', 10)
const TICK_MS = parseInt(process.env.DENSITY_TICK_MS || '250', 10)
const TICK_SLICES = parseInt(process.env.DENSITY_TICK_SLICES || '10', 10)
const BROADCAST_MS = parseInt(process.env.DENSITY_BROADCAST_MS || '2000', 10)
const RESCAN_MS = parseInt(process.env.DENSITY_RESCAN_MS || '60000', 10)
const STEP_PCT = parseFloat(process.env.DENSITY_STEP_PCT || '0.0005')
const TOP_K_PER_SIDE = parseInt(process.env.DENSITY_TOP_K || '5', 10)
const CAP_WALLS = parseInt(process.env.DENSITY_CAP || '1000', 10)
/** detection window around mid, % */
const WINDOW_PCT = parseFloat(process.env.DENSITY_WINDOW_PCT || '5')
/** top-of-book exclusion zone from the best price, % */
const SPREAD_EXCL_PCT = parseFloat(process.env.DENSITY_SPREAD_EXCL_PCT || '0.1')
/** a wall must be ≥ this × the coin's ordinary bucket scale */
const STANDOUT = parseFloat(process.env.DENSITY_STANDOUT || '5')
/** absolute floor for the threshold (dead-book noise) */
const BRP_FLOOR = parseFloat(process.env.DENSITY_BRP_FLOOR || '50000')
/** buckets in the window required to trust the ordinary scale */
const MIN_BUCKETS = parseInt(process.env.DENSITY_MIN_BUCKETS || '6', 10)
const WALL_GRACE_MS = parseInt(process.env.DENSITY_WALL_GRACE_MS || '15000', 10)
const WALL_GRACE_TICKS = Math.max(2, Math.ceil(WALL_GRACE_MS / TICK_MS))
const MATCH_TOL_PCT = parseFloat(process.env.DENSITY_MATCH_TOL || '0.1')

interface BookState {
  exchange: Exchange
  symbol: string
  bids: Map<number, number>
  asks: Map<number, number>
  mid: number
  bestBid: number
  bestAsk: number
  dirty: boolean
  /** last computed threshold — reported to clients as the symbol's БРП */
  lastBrp: number | null
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


function onDepth(depth: UnifiedDepth): void {
  const k = key(depth.exchange, depth.symbol)
  const existing = books.get(k)
  if (!existing) return
  existing.bids = new Map(depth.bids)
  existing.asks = new Map(depth.asks)
  const bestBid = depth.bids[0]?.[0]
  const bestAsk = depth.asks[0]?.[0]
  if (bestBid && bestAsk && bestBid > 0 && bestAsk > 0) {
    existing.bestBid = bestBid
    existing.bestAsk = bestAsk
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

/** The coin's ordinary-order scale for one side: trimmed median bucket size
 *  in [loPrice, hiPrice] (top 10% dropped so walls and the spread stack
 *  cannot inflate their own baseline). Null when the book is too thin. */
function ordinaryScale(
  buckets: Map<number, { size: number; maxPrice: number }>,
  loPrice: number,
  hiPrice: number,
): number | null {
  const sizes: number[] = []
  for (const b of buckets.values()) {
    if (b.maxPrice < loPrice || b.maxPrice > hiPrice) continue
    sizes.push(b.size)
  }
  if (sizes.length < MIN_BUCKETS) return null
  sizes.sort((a, b) => a - b)
  const drop = Math.ceil(sizes.length * 0.1)
  const kept = sizes.slice(0, sizes.length - drop)
  if (kept.length === 0) return null
  const mid = Math.floor(kept.length / 2)
  return kept.length % 2 === 1 ? kept[mid] : (kept[mid - 1] + kept[mid]) / 2
}

/** Local maxima (strictly larger than both neighbours) above threshold,
 *  candidates restricted to [loPrice, hiPrice] (window minus spread zone). */
function detectWalls(
  buckets: Map<number, { size: number; maxPrice: number; maxSize: number }>,
  threshold: number,
  topK: number,
  loPrice: number,
  hiPrice: number,
): { idx: number; size: number; price: number }[] {
  const idxs = Array.from(buckets.keys()).sort((a, b) => a - b)
  const found: { idx: number; size: number; price: number }[] = []
  for (let i = 0; i < idxs.length; i++) {
    const idx = idxs[i]
    const bucket = buckets.get(idx)!
    if (bucket.size < threshold) continue
    if (bucket.maxPrice < loPrice || bucket.maxPrice > hiPrice) continue
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
  const win = WINDOW_PCT / 100
  const excl = SPREAD_EXCL_PCT / 100
  // bids: [mid×(1−win), bestBid×(1−excl)]; asks: [bestAsk×(1+excl), mid×(1+win)]
  const bidLo = mid * (1 - win)
  const bidHi = state.bestBid > 0 ? state.bestBid * (1 - excl) : mid
  const askLo = state.bestAsk > 0 ? state.bestAsk * (1 + excl) : mid
  const askHi = mid * (1 + win)

  const bidBuckets = clusterSide(state.bids, step)
  const askBuckets = clusterSide(state.asks, step)

  const bidScale = ordinaryScale(bidBuckets, bidLo, bidHi)
  const askScale = ordinaryScale(askBuckets, askLo, askHi)
  const bidThr = bidScale !== null ? Math.max(STANDOUT * bidScale, BRP_FLOOR) : null
  const askThr = askScale !== null ? Math.max(STANDOUT * askScale, BRP_FLOOR) : null
  state.lastBrp = Math.max(bidThr ?? 0, askThr ?? 0) || null

  const bidWalls = bidThr !== null ? detectWalls(bidBuckets, bidThr, TOP_K_PER_SIDE, bidLo, bidHi) : []
  const askWalls = askThr !== null ? detectWalls(askBuckets, askThr, TOP_K_PER_SIDE, askLo, askHi) : []

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
    for (const adapter of depthAdapters) {
      const k = key(adapter.exchange, ticker.symbol)
      wanted.add(k)
      if (subscribed.has(k)) continue
      subscribed.add(k)
      books.set(k, { exchange: adapter.exchange, symbol: ticker.symbol, bids: new Map(), asks: new Map(), mid: ticker.price, bestBid: 0, bestAsk: 0, dirty: true, lastBrp: null })
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
    autoBrp: state.lastBrp,
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
  seedBook(exchange: Exchange, symbol: string, mid: number): void {
    books.set(key(exchange, symbol), { exchange, symbol, bids: new Map(), asks: new Map(), mid, bestBid: 0, bestAsk: 0, dirty: true, lastBrp: null })
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
