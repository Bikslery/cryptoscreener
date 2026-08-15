import type { ExchangeAdapter, DepthCallback } from '../exchanges/types.js'
import type { Exchange, UnifiedDepth, DensityWall, DensitySnapshot } from '../../types.js'
import { getTickers } from '../aggregator/index.js'
import { broadcastToChannel } from '../../ws/hub.js'
import { getRedisPub, REDIS_ENABLED } from '../../redis.js'

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
const DEFAULT_BRP = parseFloat(process.env.DENSITY_DEFAULT_BRP || '300000')
const MIN_MULT = parseFloat(process.env.DENSITY_MIN_MULT || '2')
const WARMUP_MINUTES = parseInt(process.env.DENSITY_WARMUP_MINUTES || '60', 10)
const AUTO_BRP_WINDOW_MINUTES = 24 * 60

interface BookState {
  exchange: Exchange
  symbol: string
  bids: Map<number, number>
  asks: Map<number, number>
  mid: number
  dirty: boolean
}

interface WallState {
  wall: DensityWall
  lastSeenTick: number
}

interface BrpRing {
  slots: ({ minute: number; size: number } | null)[]
}

const books = new Map<string, BookState>()
const walls = new Map<string, WallState>()
const brpRings = new Map<string, BrpRing>()
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

function brpRingOf(exchange: Exchange, symbol: string): BrpRing {
  const k = key(exchange, symbol)
  let ring = brpRings.get(k)
  if (!ring) {
    ring = { slots: new Array(AUTO_BRP_WINDOW_MINUTES).fill(null) }
    brpRings.set(k, ring)
  }
  return ring
}

function recordClusterSize(exchange: Exchange, symbol: string, size: number): void {
  const ring = brpRingOf(exchange, symbol)
  const minute = Math.floor(Date.now() / 60000)
  const idx = minute % AUTO_BRP_WINDOW_MINUTES
  const prev = ring.slots[idx]
  if (prev === null || prev.minute !== minute) {
    ring.slots[idx] = { minute, size }
  } else if (size > prev.size) {
    ring.slots[idx] = { minute, size }
  }
}

/** Median of the top quartile of per-minute max cluster sizes over the
 *  rolling window. Returns null until WARMUP_MINUTES minutes of data exist. */
function computeAutoBrp(exchange: Exchange, symbol: string): number | null {
  const ring = brpRingOf(exchange, symbol)
  const nowMinute = Math.floor(Date.now() / 60000)
  const values: number[] = []
  for (const s of ring.slots) {
    if (s === null) continue
    if (nowMinute - s.minute >= AUTO_BRP_WINDOW_MINUTES) continue
    values.push(s.size)
  }
  if (values.length < WARMUP_MINUTES) return null
  values.sort((a, b) => a - b)
  const quartileStart = Math.floor(values.length * 0.75)
  const quartile = values.slice(quartileStart)
  if (quartile.length === 0) return null
  const mid = Math.floor(quartile.length / 2)
  return quartile.length % 2 === 1 ? quartile[mid] : (quartile[mid - 1] + quartile[mid]) / 2
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
  const autoBrp = computeAutoBrp(state.exchange, state.symbol)
  const threshold = (autoBrp ?? DEFAULT_BRP) * MIN_MULT

  const bidBuckets = clusterSide(state.bids, step)
  const askBuckets = clusterSide(state.asks, step)

  // Track the per-minute max cluster size for the auto-БРП baseline (all
  // clusters, not only walls — walls can be rare on quiet books).
  let maxCluster = 0
  for (const b of bidBuckets.values()) if (b.size > maxCluster) maxCluster = b.size
  for (const b of askBuckets.values()) if (b.size > maxCluster) maxCluster = b.size
  if (maxCluster > 0) recordClusterSize(state.exchange, state.symbol, maxCluster)

  const bidWalls = detectWalls(bidBuckets, threshold, TOP_K_PER_SIDE)
  const askWalls = detectWalls(askBuckets, threshold, TOP_K_PER_SIDE)

  const seen = new Set<string>()
  for (const side of ['bid', 'ask'] as const) {
    for (const w of side === 'bid' ? bidWalls : askWalls) {
      const wk = `${k}:${side}:${w.idx}`
      seen.add(wk)
      const existing = walls.get(wk)
      if (existing) {
        existing.lastSeenTick = tickCounter
        existing.wall.sizeUsdt = w.size
        existing.wall.price = w.price
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
        lastSeenTick: tickCounter,
      })
    }
  }
  // Expire walls not seen this tick.
  for (const [wk, ws] of walls) {
    if (!wk.startsWith(k + ':')) continue
    if (ws.lastSeenTick !== tickCounter) walls.delete(wk)
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
      if (!books.has(k)) {
        books.set(k, { exchange: adapter.exchange, symbol: ticker.symbol, bids: new Map(), asks: new Map(), mid: ticker.price, dirty: true })
      }
      adapter.subscribeDepth(ticker.symbol, cb)
    }
  }

  for (const k of Array.from(subscribed)) {
    if (wanted.has(k)) continue
    subscribed.delete(k)
    books.delete(k)
    brpRings.delete(k)
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
  const all = Array.from(walls.values()).map(w => w.wall)
  all.sort((a, b) => b.sizeUsdt - a.sizeUsdt)
  const capped = all.slice(0, CAP_WALLS)
  const autoBrps = Array.from(brpRings.entries()).map(([k, ring]) => {
    const [exchange, symbol] = k.split(':')
    // Only report symbols that still have a live book.
    if (!books.has(k)) return null
    return { symbol, exchange: exchange as Exchange, autoBrp: computeAutoBrp(exchange as Exchange, symbol) }
  }).filter((v): v is { symbol: string; exchange: Exchange; autoBrp: number | null } => v !== null)
  return { ts: Date.now(), walls: capped, autoBrps }
}

function publishSnapshot(): void {
  lastSnapshot = buildSnapshot()
  if (lastSnapshot.walls.length === 0) return
  broadcastToChannel('density', lastSnapshot, true)
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

  // Ops visibility: books/walls/snapshot size once a minute.
  setInterval(() => {
    const st = getDensityStats()
    console.log(`[Density] stats books=${st.books} subscribed=${st.subscribed} walls=${st.walls} snapshotWalls=${st.snapshotWalls}`)
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
