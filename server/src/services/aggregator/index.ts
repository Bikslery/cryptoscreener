import type { Exchange, UnifiedTicker, UnifiedCandle, UnifiedDepth } from '../../types.js'
import { BinanceSpotAdapter } from '../exchanges/binance-spot.js'
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.js'
import { BybitFuturesAdapter } from '../exchanges/bybit-futures.js'
import type { ExchangeAdapter } from '../exchanges/types.js'
import { RateLimitError } from '../exchanges/errors.js'
import { broadcast, broadcastToChannel } from '../../ws/hub.js'
import { updateCachedCandle, getCachedCandles } from '../candles/candle-cache.js'
import { getRedisPub, getRedisData, REDIS_ENABLED } from '../../redis.js'
import { subscribeAggTrade, unsubscribeAggTrade } from '../trades/aggTrade.js'
import { pearson, computeVolumeSpike, TradeBucketTracker, applyIndicator, CORR_WINDOW, MAX_BUCKETS } from './indicators.js'

export const adapters: ExchangeAdapter[] = [
  new BinanceSpotAdapter(),
  new BinanceFuturesAdapter(),
  new BybitFuturesAdapter(),
]

const tickerMap = new Map<string, UnifiedTicker>()

// Last forwarded bookTicker mid per symbol:exchange — dedupe guard for the
// `price:` fast lane so an unchanged mid isn't re-broadcast on every event.
const lastMidCache = new Map<string, number>()

// --- Price-lane coalescing ---------------------------------------------------
// bookTicker fires on EVERY top-of-book change — dozens/sec on liquid pairs.
// Broadcasting each change immediately, on top of the per-trade trade+kline
// lanes, flooded the client's serial parse queue (the visible "chart lags the
// стакан"). The mid is a FALLBACK price source (trades are primary), so it is
// fully coalescable: latest-wins flush every PRICE_LANE_INTERVAL_MS.
interface PendingMid {
  symbol: string
  exchange: string
  price: number
}

const PRICE_LANE_INTERVAL_MS = parseInt(process.env.PRICE_LANE_INTERVAL_MS || '40', 10)
const pendingMids = new Map<string, PendingMid>()
let midFlushTimer: ReturnType<typeof setTimeout> | null = null

function queueMid(symbol: string, exchange: string, mid: number): void {
  pendingMids.set(`${symbol}:${exchange}`, { symbol, exchange, price: mid })
  if (midFlushTimer === null) {
    midFlushTimer = setTimeout(flushPendingMids, PRICE_LANE_INTERVAL_MS)
  }
}

function flushPendingMids(): void {
  midFlushTimer = null
  for (const [key, m] of pendingMids) {
    pendingMids.delete(key)
    const payload = { symbol: m.symbol, exchange: m.exchange, price: m.price, ts: Date.now() }
    if (isBroadcast) broadcastToChannel(`price:${m.symbol}`, payload, true)
    if (isIngestion && REDIS_ENABLED) {
      try {
        getRedisPub().publish('price', JSON.stringify(payload)).catch(() => {})
      } catch { /* redis down */ }
    }
  }
}

// --- Configurable exchange priority (env overrides hardcoded defaults) ---

const DEFAULT_PRIORITY: Record<string, number> = {
  'binance-futures': 5,
  'bybit-futures': 4,
  'okx-spot': 3,
  'binance-spot': 2,
}

export function parseExchangePriority(envStr: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const pair of envStr.split(',')) {
    const [ex, pri] = pair.split(':')
    if (ex && pri) result[ex.trim()] = parseInt(pri.trim(), 10) || 0
  }
  return result
}

export function parseBlacklist(envStr: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const segment of envStr.split(';')) {
    const [ex, symbols] = segment.split(':')
    if (!ex || !symbols) continue
    result.set(ex.trim(), new Set(symbols.split(',').map(s => s.trim()).filter(Boolean)))
  }
  return result
}

export function parseOverrides(envStr: string): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>()
  try {
    const obj = JSON.parse(envStr) as Record<string, Record<string, number>>
    for (const [symbol, exchanges] of Object.entries(obj)) {
      const inner = new Map<string, number>()
      for (const [ex, pri] of Object.entries(exchanges)) inner.set(ex, pri)
      result.set(symbol, inner)
    }
  } catch {
    console.warn('[Aggregator] Failed to parse EXCHANGE_SYMBOL_OVERRIDES — ignoring')
  }
  return result
}

/**
 * Pure core of best-coin selection: given a stream of unified tickers and the
 * priority/blacklist config, returns the highest-priority ticker per symbol.
 * Extracted so the selection logic is unit-testable without touching the
 * module-global ticker map.
 */
export function pickBestTickers(
  tickers: Iterable<UnifiedTicker>,
  opts: {
    isBlacklisted: (exchange: string, symbol: string) => boolean
    getPriority: (exchange: string, symbol?: string) => number
  },
): Map<string, UnifiedTicker> {
  const best = new Map<string, UnifiedTicker>()
  for (const t of tickers) {
    if (opts.isBlacklisted(t.exchange, t.symbol)) continue
    const existing = best.get(t.symbol)
    const prioT = opts.getPriority(t.exchange, t.symbol)
    const prioE = existing ? opts.getPriority(existing.exchange, existing.symbol) : -1
    if (!existing || prioT > prioE) {
      best.set(t.symbol, t)
    }
  }
  return best
}

/**
 * Pure core of delta computation: compares the incoming tickers against the
 * previously broadcast state and returns (a) only the tickers whose observable
 * fields changed, plus removals, and (b) the state to feed the next call.
 * Extracted so the merge/delta logic is deterministic and unit-testable.
 *
 * MUTATES `prev` IN PLACE: this runs on every broadcast flush (25-50Hz over
 * ~1200 tickers); rebuilding a fresh Map with a new partial object per ticker
 * allocated ~60k objects/sec and showed up as GC micro-hitches in the price
 * lane. The returned `next` IS the same Map instance that was passed in.
 */
export function computeTickerDelta(
  tickers: UnifiedTicker[],
  prev: Map<string, Partial<UnifiedTicker>>,
): { delta: UnifiedTicker[]; next: Map<string, Partial<UnifiedTicker>> } {
  const delta: UnifiedTicker[] = []
  const seen = new Set<string>()
  for (const t of tickers) {
    const key = `${t.symbol}:${t.exchange}`
    seen.add(key)
    const p = prev.get(key)
    if (!p || p.price !== t.price || p.change24h !== t.change24h || p.quoteVolume24h !== t.quoteVolume24h
      || p.corrBtc !== t.corrBtc || p.tradesSpike !== t.tradesSpike || p.volumeSpike !== t.volumeSpike
      || p.lastClose !== t.lastClose) {
      delta.push(t)
    }
    if (p) {
      p.price = t.price
      p.change24h = t.change24h
      p.quoteVolume24h = t.quoteVolume24h
      p.corrBtc = t.corrBtc
      p.tradesSpike = t.tradesSpike
      p.volumeSpike = t.volumeSpike
      p.lastClose = t.lastClose
    } else {
      prev.set(key, {
        symbol: t.symbol,
        exchange: t.exchange,
        price: t.price,
        change24h: t.change24h,
        quoteVolume24h: t.quoteVolume24h,
        corrBtc: t.corrBtc,
        tradesSpike: t.tradesSpike,
        volumeSpike: t.volumeSpike,
        lastClose: t.lastClose,
      })
    }
  }
  for (const key of prev.keys()) {
    if (!seen.has(key)) {
      const p = prev.get(key)
      if (p) delta.push(p as UnifiedTicker)
      prev.delete(key)
    }
  }
  return { delta, next: prev }
}

const EXCHANGE_PRIORITY: Record<string, number> = {
  ...DEFAULT_PRIORITY,
  ...(process.env.EXCHANGE_PRIORITY ? parseExchangePriority(process.env.EXCHANGE_PRIORITY) : {}),
}

const SYMBOL_BLACKLIST: Map<string, Set<string>> = process.env.EXCHANGE_SYMBOL_BLACKLIST
  ? parseBlacklist(process.env.EXCHANGE_SYMBOL_BLACKLIST)
  : new Map()

const SYMBOL_OVERRIDES: Map<string, Map<string, number>> = process.env.EXCHANGE_SYMBOL_OVERRIDES
  ? parseOverrides(process.env.EXCHANGE_SYMBOL_OVERRIDES)
  : new Map()

function isBlacklisted(exchange: string, symbol: string): boolean {
  return SYMBOL_BLACKLIST.get(exchange)?.has(symbol) ?? false
}

function getPriority(exchange: string, symbol?: string): number {
  if (symbol) {
    const override = SYMBOL_OVERRIDES.get(symbol)?.get(exchange)
    if (override !== undefined) return override
  }
  return EXCHANGE_PRIORITY[exchange] ?? 0
}

function pickBestFromMap(): Map<string, UnifiedTicker> {
  return pickBestTickers(tickerMap.values(), { isBlacklisted, getPriority })
}

// Broadcast cadence: price deltas every TICKER_BROADCAST_INTERVAL_MS (default
// 40ms ≈ 25Hz), plus a full snapshot every TICKER_SNAPSHOT_INTERVAL_MS (default
// 5s — deltas keep clients consistent between snapshots, so the full-array
// re-sort is rare). Clients merge deltas in place and replace state on
// snapshots — shipping the whole ~1200-ticker array at 25Hz would drown the
// wire even deflated.
//
// Adaptive cadence: in active markets (measured price-change rate above
// TICKER_ADAPTIVE_THRESHOLD_TPS) frames flush every
// TICKER_BROADCAST_INTERVAL_FAST_MS (20ms ≈ 50Hz); in calm markets the slower
// default interval is kept to save bandwidth.
const BROADCAST_INTERVAL = parseInt(process.env.TICKER_BROADCAST_INTERVAL_MS || '40', 10)
const BROADCAST_INTERVAL_FAST = parseInt(process.env.TICKER_BROADCAST_INTERVAL_FAST_MS || '20', 10)
const ADAPTIVE_ACTIVE_TPS = parseInt(process.env.TICKER_ADAPTIVE_THRESHOLD_TPS || '500', 10)
const SNAPSHOT_INTERVAL = parseInt(process.env.TICKER_SNAPSHOT_INTERVAL_MS || '5000', 10)
let lastBroadcast = 0
let lastSnapshotBroadcast = 0
// Adaptive-cadence accounting: how many real price changes landed per second.
let priceChangeCount = 0
let priceChangesWindowStart = Date.now()
let priceChangesPerSec = 0
let loggedFirst = false
let tickerCount = 0
let lastBroadcastLog = 0
const metricsMap = new Map<string, { range1m: number; natr5m: number }>()

// 5m trade-count buckets fed by the Binance aggTrade lanes (spot + futures
// per symbol). Bybit/OKX tickers never receive tradesSpike — the metric is
// Binance-only, matching the scalpboard "Только для Binance" convention.
const tradeBuckets = new TradeBucketTracker()
const BINANCE_EXCHANGES = new Set(['binance-spot', 'binance-futures'])

// Persistent indicator values per symbol. Ticker objects are REPLACED on
// every exchange update (parseTicker builds fresh ones with null fields), so
// values must live here and be re-applied on each tick — same pattern as
// metricsMap/range1m/natr5m.
const indicatorMap = new Map<string, { corrBtc: number | null; volumeSpike: number | null; tradesSpike: number | null }>()

// Close of the last closed 5m candle per symbol:exchange — scalpboard's
// price_5m_1. Fed event-driven (each final 5m kline) and seeded periodically
// for the top-N coins from the candle cache. The client shows the LIVE price
// against this reference to color the price column (price above last close =
// bullish candle).
const lastCloseMap = new Map<string, number>()

function setIndicator(symbol: string, field: 'corrBtc' | 'volumeSpike' | 'tradesSpike', value: number | null): void {
  const cur = indicatorMap.get(symbol) || { corrBtc: null, volumeSpike: null, tradesSpike: null }
  cur[field] = value
  indicatorMap.set(symbol, cur)
  // Write straight into the live ticker map so the next delta carries the
  // change immediately; tradesSpike stays Binance-only.
  applyIndicator(tickerMap, symbol, { [field]: value }, field === 'tradesSpike' ? BINANCE_EXCHANGES : undefined)
}

function applyIndicatorsToTicker(ticker: UnifiedTicker): void {
  const ind = indicatorMap.get(ticker.symbol)
  if (ind) {
    ticker.corrBtc = ind.corrBtc
    ticker.volumeSpike = ind.volumeSpike
    ticker.tradesSpike = BINANCE_EXCHANGES.has(ticker.exchange) ? ind.tradesSpike : null
  }
  const lc = lastCloseMap.get(`${ticker.symbol}:${ticker.exchange}`)
  if (lc !== undefined) ticker.lastClose = lc
}

export function recordTradeBucket(symbol: string, timeMs: number): void {
  const res = tradeBuckets.recordTrade(symbol, timeMs)
  if (res) {
    setIndicator(symbol, 'tradesSpike', Math.round(res.spike * 10000) / 10000)
  }
}

export function getTradeBucketStats(): { trackedSymbols: number } {
  return { trackedSymbols: tradeBuckets.size }
}

let cachedBestMap: Map<string, UnifiedTicker> | null = null
let cachedBest: UnifiedTicker[] | null = null
let lastBroadcastedTickers = new Map<string, Partial<UnifiedTicker>>()

function getBestMap(): Map<string, UnifiedTicker> {
  if (!cachedBestMap) cachedBestMap = pickBestFromMap()
  return cachedBestMap
}

function computeDelta(tickers: UnifiedTicker[]): UnifiedTicker[] {
  const { delta, next } = computeTickerDelta(tickers, lastBroadcastedTickers)
  lastBroadcastedTickers = next
  return delta
}

/**
 * Throttled ticker fan-out (shared by the adapter onTicker handler and the
 * aggTrade/bookTicker price paths). Emits a compact delta frame every
 * BROADCAST_INTERVAL and a full snapshot every SNAPSHOT_INTERVAL so clients
 * stay consistent without receiving the full array at 25Hz.
 */
function maybeBroadcastTickers() {
  const now = Date.now()
  // Rolling price-change rate (updated once per second).
  if (now - priceChangesWindowStart >= 1000) {
    priceChangesPerSec = priceChangeCount / ((now - priceChangesWindowStart) / 1000)
    priceChangesWindowStart = now
    priceChangeCount = 0
  }
  const interval = priceChangesPerSec >= ADAPTIVE_ACTIVE_TPS ? BROADCAST_INTERVAL_FAST : BROADCAST_INTERVAL
  if (now - lastBroadcast <= interval) return
  lastBroadcast = now

  const best = getBestMap()
  const arr = getAllTickers()
  const bestArr = Array.from(best.values())

  const delta = computeDelta(arr)
  const isSnapshot = now - lastSnapshotBroadcast >= SNAPSHOT_INTERVAL
  if (isSnapshot) lastSnapshotBroadcast = now

  if (isIngestion && REDIS_ENABLED) {
    try {
      const redis = getRedisPub()
      // Publish full + delta so broadcast-only nodes can forward the same
      // compact frames instead of re-sending the whole array at 25Hz.
      redis.publish('tickers', JSON.stringify({ full: arr, delta, snapshot: isSnapshot })).catch(() => {})
    } catch {}
  }

  if (isBroadcast) {
    if (isSnapshot || delta.length > 0) {
      // ts lets the client measure server→client latency (p50/p95).
      broadcast({ type: 'ticker', data: delta, full: arr, snapshot: isSnapshot, ts: now })
      broadcastCount++
    }
    const now2 = Date.now()
    if (now2 - lastBroadcastLog > BROADCAST_LOG_INTERVAL) {
      lastBroadcastLog = now2
      console.log(`[Aggregator] Broadcast #${broadcastCount}: ${delta.length}/${arr.length} tickers changed, ${tickerCount} total ticks received${isSnapshot ? ' (snapshot)' : ''}`)
    }
  }

  if (!loggedFirst) {
    loggedFirst = true
    console.log(`[Aggregator] First broadcast: ${arr.length} exchange tickers / ${bestArr.length} best coins (received ${tickerCount} ticks), top: ${bestArr.slice(0, 3).map(t => t.symbol).join(', ')}`)
  }

  // Re-evaluate aggTrade + bookTicker coverage periodically — the very first
  // broadcast can fire with an almost-empty ticker map, so wait until it has
  // populated before subscribing (and keep refreshing as rankings shift).
  if (bestArr.length >= AGGTRADE_MIN_SYMBOLS && now - lastAggTradeResubscribe > AGGTRADE_RESUBSCRIBE_INTERVAL) {
    lastAggTradeResubscribe = now
    syncAggTradeSubscriptions()
    syncBookTickerSubscriptions()
  }
}

const ROLE = process.env.ROLE || 'all'
const isBroadcast = ROLE === 'broadcast' || ROLE === 'all'
const isIngestion = ROLE === 'ingestion' || ROLE === 'all'

let broadcastCount = 0
const BROADCAST_LOG_INTERVAL = 30_000

export function startAggregator() {
  logPriorityConfig()
  for (const adapter of adapters) {
    adapter.onTicker((ticker) => {
      if (isBlacklisted(ticker.exchange, ticker.symbol)) return
      const m = metricsMap.get(ticker.symbol)
      if (m) {
        ticker.range1m = m.range1m
        ticker.natr5m = m.natr5m
      }
      applyIndicatorsToTicker(ticker)
      tickerMap.set(`${ticker.symbol}:${ticker.exchange}`, ticker)
      cachedBestMap = null
      cachedBest = null
      tickerCount++
      // NOTE: exchanges are honest, independent sources — Bybit prices are
      // never cross-fed into binance-futures entries (per-market prices can
      // decohere during volatile moves, and the UI label must match the
      // actual source).
      maybeBroadcastTickers()
    })

    adapter.onCandle((candle) => {
      updateCachedCandle(candle)
      if (candle.timeframe === '5m' && candle.isFinal) {
        lastCloseMap.set(`${candle.symbol}:${candle.exchange}`, candle.close)
      }
      if (isIngestion && REDIS_ENABLED) {
        try {
          const redis = getRedisPub()
          redis.publish('candles', JSON.stringify(candle)).catch(() => {})
        } catch {}
      }
      // NOTE: no local broadcast here. The candle manager's per-subscription
      // callback (createCandleManager → candleCallback) already broadcasts
      // the same candle IMMEDIATELY to subscribed charts. A second broadcast
      // from here (batched at WS_BATCH_INTERVAL_MS) duplicated every kline
      // frame on the wire and repainted the forming bar ~40 ms late with
      // identical values.
    })

    // Depth is NOT broadcast to a local WS channel: nothing subscribes to
    // `depth:*`. The density engine consumes depth directly through its own
    // adapter.subscribeDepth callback, and clients only ever subscribe to
    // ticker / candle:* / trade:* / price:* / density. A local broadcast here
    // ran encodePayload + a full client scan for every book update of every
    // tracked symbol, and every resulting frame was discarded. Redis publish
    // stays: split ingestion/broadcast deployments relay it (hub.ts).
    adapter.onDepth((depth) => {
      if (isIngestion && REDIS_ENABLED) {
        try {
          const redis = getRedisPub()
          redis.publish('depth', JSON.stringify(depth)).catch(() => {})
        } catch {}
      }
    })

    // Best bid/ask midpoint → live price for top liquid pairs (bookTicker).
    // Optional capability — only adapters that expose it participate; others
    // keep their price updates on aggTrade/miniTicker as before.
    //
    // The mid must NOT overwrite the ticker map price: it sits inside the
    // spread and wobbles ±spread/2 on thin books, making the displayed price
    // flicker around the true last-trade price (which trading terminals show
    // and which arrives via aggTrade + miniTicker). The mid only feeds the
    // per-symbol `price:` fast lane — the client uses it as a fallback for
    // pairs with sparse trades.
    adapter.onBookTicker?.((symbol, mid) => {
      if (!isFinite(mid) || mid <= 0) return
      const lastKey = `${symbol}:${adapter.exchange}`
      if (lastMidCache.get(lastKey) === mid) return
      lastMidCache.set(lastKey, mid)
      // Coalesced latest-wins fast lane (see queueMid) — the mid is a
      // fallback source; the chart needs the newest value, not every book
      // change, and coalescing keeps the client's frame queue clear.
      queueMid(symbol, adapter.exchange, mid)
    })

    console.log(`[Aggregator] Starting adapter: ${adapter.name} (${adapter.exchange})`)
    adapter.connect()
  }

  computeMetrics()
  startCorrelationLoop()
}

const AGGTRADE_MIN_SYMBOLS = 30
const AGGTRADE_RESUBSCRIBE_INTERVAL = 60_000
const subscribedAggTradeSymbols = new Set<string>()
let lastAggTradeResubscribe = 0

// Per-symbol bookTicker (best bid/ask) coverage for the top BOOKTICKER_TOP_N
// pairs per exchange by 24h quote volume. Unlike !miniTicker@arr (batched
// ~1Hz), bookTicker fires on EVERY top-of-book change — dozens of updates/sec
// on liquid pairs — so their displayed price tracks the market continuously.
// Raised to 500 by default: Binance allows 1024 streams per connection, so a
// 500-symbol pool spans a few connections and gives the whole visible list a
// live bid/ask price instead of only the very top.
const BOOKTICKER_TOP_N = parseInt(process.env.BOOKTICKER_TOP_N || '500', 10)
const subscribedBookTicker = new Map<string, Set<string>>() // exchange → symbols

// Subscribe EVERY symbol on EVERY exchange to its aggTrade stream, so all
// prices (coin list, top bar, charts) update instantly per trade — not just
// the top-N by volume. aggTrade.ts chunks the streams across multiple WS
// connections to stay under Binance's URL limit. New listings are picked up
// by the periodic re-sync below.
function syncAggTradeSubscriptions() {
  const all = getAllTickers()
  const newSymbols = new Set<string>()
  for (const t of all) {
    // Bybit symbols get realtime prices from Bybit's own ticker WS — do NOT
    // subscribe them to Binance SPOT aggTrade streams: that mislabeled them
    // (trade channels broadcast as trade:bybit-futures:*) and could poison
    // whole chunk connections with streams that don't exist on Binance spot.
    if (t.exchange === 'bybit-futures') continue
    newSymbols.add(`${t.symbol}:${t.exchange}`)
    if (!subscribedAggTradeSymbols.has(`${t.symbol}:${t.exchange}`)) {
      subscribeAggTrade(t.symbol, t.exchange)
    }
  }

  for (const key of subscribedAggTradeSymbols) {
    if (!newSymbols.has(key)) {
      const [sym, ex] = key.split(':') as [string, Exchange]
      unsubscribeAggTrade(sym, ex)
    }
  }

  subscribedAggTradeSymbols.clear()
  for (const s of newSymbols) subscribedAggTradeSymbols.add(s)
  console.log(`[Aggregator] Subscribed aggTrade for ${newSymbols.size} symbols`)
}

// Keep each exchange's bookTicker pool aligned with its current top-N by
// volume (rankings shift as the market moves; pools refresh every re-sync).
// Every adapter that exposes bookTicker (Binance Futures, Bybit) participates.
function syncBookTickerSubscriptions() {
  // Hoisted out of the adapter loop: getAllTickers() used to be called once
  // per adapter (3 full rebuilds per re-sync for no reason).
  const all = getAllTickers()
  for (const adapter of adapters) {
    if (!adapter.subscribeBookTicker || !adapter.unsubscribeBookTicker) continue
    const subscribe = adapter.subscribeBookTicker.bind(adapter)
    const unsubscribe = adapter.unsubscribeBookTicker.bind(adapter)

    const top = all
      .filter(t => t.exchange === adapter.exchange)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, BOOKTICKER_TOP_N)
    const wanted = new Set(top.map(t => t.symbol))

    const pool = subscribedBookTicker.get(adapter.exchange) || new Set<string>()
    let added = 0
    let removed = 0
    for (const sym of wanted) {
      if (!pool.has(sym)) {
        subscribe(sym)
        added++
      }
    }
    for (const sym of pool) {
      if (!wanted.has(sym)) {
        unsubscribe(sym)
        removed++
      }
    }
    subscribedBookTicker.set(adapter.exchange, wanted)
    if (added > 0 || removed > 0) {
      console.log(`[Aggregator] BookTicker sync (${adapter.exchange}): +${added} -${removed} → ${wanted.size} symbols`)
    }
  }
}

async function computeMetrics() {
  const compute = async () => {
    const best = getBestMap()
    const topCoins = Array.from(best.values())
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 200)

    const symbolsToRemove: string[] = []
    const BATCH_SIZE = 10

    for (let i = 0; i < topCoins.length; i += BATCH_SIZE) {
      if (anyLimiterOverThreshold()) {
        console.warn('[Metrics] Rate limit threshold reached, skipping batch')
        break
      }
      const batch = topCoins.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(async (coin) => {
        try {
          const cached1m = getCachedCandles(coin.symbol, '1m', coin.exchange)
          let candles1m: UnifiedCandle[]
          if (cached1m && cached1m.length >= 2) {
            candles1m = cached1m.slice(-5)
          } else {
            candles1m = await fetchCandles(coin.symbol, '1m', 5, coin.exchange)
          }
          if (candles1m.length >= 2) {
            const highs = candles1m.map(c => c.high)
            const lows = candles1m.map(c => c.low)
            const minLow = Math.min(...lows)
            const maxHigh = Math.max(...highs)
            const range1m = minLow > 0 ? ((maxHigh - minLow) / minLow) * 100 : 0
            metricsMap.set(coin.symbol, { ...(metricsMap.get(coin.symbol) || { natr5m: 0 }), range1m })
          }

          const cached5m = getCachedCandles(coin.symbol, '5m', coin.exchange)
          let candles5m: UnifiedCandle[]
          if (cached5m && cached5m.length >= MAX_BUCKETS + 1) {
            candles5m = cached5m
          } else if (cached5m && cached5m.length >= 14) {
            // Enough for natr5m; volumeSpike stays null until the window fills.
            candles5m = cached5m
          } else {
            candles5m = await fetchCandles(coin.symbol, '5m', MAX_BUCKETS + 1, coin.exchange)
          }
          if (candles5m.length >= 2) {
            const window = candles5m.slice(-14)
            const trs = window.map((c, i) => {
              if (i === 0) return c.high - c.low
              const prevClose = window[i - 1].close
              return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
            })
            const atr = trs.reduce((s, v) => s + v, 0) / trs.length
            const natr5m = coin.price > 0 ? (atr / coin.price) * 100 : 0
            metricsMap.set(coin.symbol, { ...(metricsMap.get(coin.symbol) || { range1m: 0 }), natr5m })
          }
          // Last closed 5m candle close (scalpboard's price_5m_1) — seed the
          // reference price for coins whose 5m stream isn't actively charted.
          if (candles5m.length > 0) {
            let lastClose: number | null = null
            for (let i = candles5m.length - 1; i >= 0; i--) {
              if (candles5m[i].isFinal) { lastClose = candles5m[i].close; break }
            }
            if (lastClose === null) lastClose = candles5m[candles5m.length - 1].close
            lastCloseMap.set(`${coin.symbol}:${coin.exchange}`, lastClose)
          }
          // Volume spike: forming 5m candle vs the average of the 30 completed
          // before it. Cheap (cache-first) so it refreshes with every 30s pass.
          const spike = computeVolumeSpike(candles5m)
          setIndicator(coin.symbol, 'volumeSpike', spike !== null ? Math.round(spike * 10000) / 10000 : null)
        } catch (e) {
          console.warn(`[Metrics] Failed for ${coin.symbol}:`, e instanceof Error ? e.message : e)
        }
      }))
    }

    // Re-apply every tracked tradesSpike so symbols whose bucket rolled over
    // without fresh trades still push the new value into the delta lane.
    for (const [symbol, spike] of tradeBuckets.entries()) {
      setIndicator(symbol, 'tradesSpike', spike !== null ? Math.round(spike * 10000) / 10000 : null)
    }

    for (const [symbol] of metricsMap) {
      if (!best.has(symbol)) symbolsToRemove.push(symbol)
    }
    for (const s of symbolsToRemove) {
      metricsMap.delete(s)
      indicatorMap.delete(s)
    }

    console.log(`[Metrics] Updated range1m/natr5m for top ${topCoins.length} coins (cache hits preferred)`)
  }

  await new Promise(r => setTimeout(r, 15_000))
  await compute()
  // 60s cadence (was 30s): the pass is cache-first, but its 1m/5m REST misses
  // still burn budget; halving the cadence halves that pressure and leaves
  // more weight for live chart history.
  setInterval(compute, 60_000)
}

// BTC correlation runs on its own slow cadence — Pearson over 60 5m closes
// is the only metric that needs two aligned candle series per coin, so 30s
// would waste REST weight for zero new information (the window moves by one
// candle per 5 minutes anyway).
const CORR_INTERVAL_MS = parseInt(process.env.CORR_INTERVAL_MS || '300000', 10)
const CORR_MIN_PAIRS = 10

async function computeCorrelation(): Promise<void> {
  const best = getBestMap()
  const topCoins = Array.from(best.values())
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, 200)

  let btcCandles = getCachedCandles('BTCUSDT', '5m', 'binance-futures')
  if (!btcCandles || btcCandles.length < CORR_WINDOW) {
    try {
      btcCandles = await fetchCandles('BTCUSDT', '5m', CORR_WINDOW, 'binance-futures')
    } catch {
      btcCandles = []
    }
  }
  const btcWindow = btcCandles.slice(-CORR_WINDOW)
  if (btcWindow.length < CORR_MIN_PAIRS) {
    console.warn(`[Corr] BTCUSDT 5m series too short (${btcWindow.length}) — skipping pass`)
    return
  }
  const btcCloses = new Map(btcWindow.map(c => [c.time, c.close]))

  const BATCH_SIZE = 10
  let updated = 0
  let nulled = 0
  for (let i = 0; i < topCoins.length; i += BATCH_SIZE) {
    if (anyLimiterOverThreshold()) {
      console.warn('[Corr] Rate limit threshold reached, skipping batch')
      break
    }
    const batch = topCoins.slice(i, i + BATCH_SIZE)
    await Promise.all(batch.map(async (coin) => {
      try {
        let candles = getCachedCandles(coin.symbol, '5m', coin.exchange)
        if (!candles || candles.length < CORR_WINDOW) {
          candles = await fetchCandles(coin.symbol, '5m', CORR_WINDOW, coin.exchange)
        }
        if (!candles || candles.length < CORR_MIN_PAIRS) {
          setIndicator(coin.symbol, 'corrBtc', null)
          nulled++
          return
        }
        const xs: number[] = []
        const ys: number[] = []
        for (const c of candles.slice(-CORR_WINDOW)) {
          const b = btcCloses.get(c.time)
          if (b !== undefined) {
            xs.push(c.close)
            ys.push(b)
          }
        }
        const r = pearson(xs, ys)
        setIndicator(coin.symbol, 'corrBtc', r !== null ? Math.round(r * 10000) / 10000 : null)
        if (r !== null) updated++
        else nulled++
      } catch (e) {
        console.warn(`[Corr] Failed for ${coin.symbol}:`, e instanceof Error ? e.message : e)
      }
    }))
  }
  console.log(`[Corr] Updated corrBtc for ${topCoins.length} coins (${updated} values, ${nulled} null, BTC window ${btcWindow.length})`)
}

function startCorrelationLoop() {
  setTimeout(() => {
    computeCorrelation().catch(() => {})
    setInterval(() => computeCorrelation().catch(() => {}), CORR_INTERVAL_MS)
  }, 30_000)
}

export function anyLimiterOverThreshold(): boolean {
  for (const a of adapters) {
    const limiter = a.getRateLimiter?.()
    if (limiter?.isOverThreshold()) return true
  }
  return false
}

export function updateTickerPrice(symbol: string, exchange: Exchange, price: number): boolean {
  // Never let NaN / non-positive prices into the ticker map — JSON.stringify
  // turns NaN into null, which made futures prices flicker to null on every
  // partial (delta) exchange message missing the last-price field.
  if (!isFinite(price) || price <= 0) return false
  const key = `${symbol}:${exchange}`
  const existing = tickerMap.get(key)
  if (!existing) return false
  if (existing.price === price) return false
  existing.price = price
  // Use stored openPrice24h directly — avoids accumulated rounding drift
  // from reverse-calculating open via price / (1 + change24h/100)
  if (existing.openPrice24h > 0) {
    existing.change24h = ((price - existing.openPrice24h) / existing.openPrice24h) * 100
  }
  existing.timestamp = Date.now()
  priceChangeCount++
  cachedBestMap = null
  cachedBest = null
  tickerCount++
  maybeBroadcastTickers()
  return true
}

export function getTickers(): UnifiedTicker[] {
  if (!cachedBest) {
    cachedBest = Array.from(getBestMap().values())
  }
  return cachedBest
}

const allTickersBuffer: UnifiedTicker[] = []

export function getAllTickers(): UnifiedTicker[] {
  // Reused buffer: this fires on every broadcast flush (25-50Hz); a fresh
  // ~1200-element array with a filter pass per call was constant GC
  // pressure. Every caller consumes the result synchronously (sort, map,
  // JSON.stringify) before any later call can rebuild it — single-threaded
  // JS guarantees that. Callers must NOT stash the array across an await.
  allTickersBuffer.length = 0
  for (const t of tickerMap.values()) {
    if (!isBlacklisted(t.exchange, t.symbol)) allTickersBuffer.push(t)
  }
  return allTickersBuffer
}

export function getTicker(symbol: string): UnifiedTicker | undefined {
  return getBestMap().get(symbol)
}

export function setTickersFromRedis(tickers: UnifiedTicker[]) {
  for (const t of tickers) {
    // Ensure openPrice24h exists — older Redis data may lack it
    if (!t.openPrice24h && t.change24h !== undefined && t.price > 0) {
      t.openPrice24h = t.price / (1 + t.change24h / 100)
    }
    if (!t.openPrice24h) t.openPrice24h = t.price
    // Normalize indicator fields — pre-indicator snapshots omit them.
    if (t.corrBtc === undefined) t.corrBtc = null
    if (t.tradesSpike === undefined) t.tradesSpike = null
    if (t.volumeSpike === undefined) t.volumeSpike = null
    if (t.lastClose === undefined) t.lastClose = null
    applyIndicatorsToTicker(t)
    tickerMap.set(`${t.symbol}:${t.exchange}`, t)
  }
  cachedBestMap = null
  cachedBest = null
}

let cachedAdaptersByPriority: ExchangeAdapter[] | null = null

function adaptersByPriority(symbol?: string): ExchangeAdapter[] {
  if (!symbol) {
    if (!cachedAdaptersByPriority) {
      cachedAdaptersByPriority = [...adapters].sort((a, b) =>
        getPriority(b.exchange) - getPriority(a.exchange)
      )
    }
    return cachedAdaptersByPriority
  }
  return [...adapters].sort((a, b) =>
    getPriority(b.exchange, symbol) - getPriority(a.exchange, symbol)
  )
}

function logPriorityConfig() {
  console.log(`[Aggregator] Priority config: ${JSON.stringify(EXCHANGE_PRIORITY)}`)
  if (SYMBOL_BLACKLIST.size > 0) {
    const entries: string[] = []
    for (const [ex, syms] of SYMBOL_BLACKLIST) entries.push(`${ex}: ${[...syms].join(',')}`)
    console.log(`[Aggregator] Symbol blacklist: ${entries.join('; ')}`)
  }
  if (SYMBOL_OVERRIDES.size > 0) {
    const entries: string[] = []
    for (const [sym, exMap] of SYMBOL_OVERRIDES) {
      for (const [ex, pri] of exMap) entries.push(`${sym}@${ex}=${pri}`)
    }
    console.log(`[Aggregator] Symbol overrides: ${entries.join(', ')}`)
  }
}

export async function fetchCandles(symbol: string, tf: string, limit: number, exchange?: Exchange, startTime?: number, endTime?: number, options?: import('../exchanges/types.js').FetchCandlesOptions): Promise<UnifiedCandle[]> {
  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  if (exchange) {
    const adapter = adapters.find(a => a.exchange === exchange)
    if (!adapter) return []
    try {
      return await adapter.fetchCandles(symbol, tf, limit, startTime, endTime, options)
    } catch {
      return []
    }
  }
  // Try target first, then all others by priority
  const ordered = adaptersByPriority(symbol)
  const targetIdx = ordered.findIndex(a => a.exchange === targetExchange)
  if (targetIdx > 0) { const [t] = ordered.splice(targetIdx, 1); ordered.unshift(t) }
  if (targetIdx === -1) {
    // target not found in adapters, just try by priority
  }

  for (const adapter of ordered) {
    try {
      const candles = await adapter.fetchCandles(symbol, tf, limit, startTime, endTime, options)
      if (candles.length > 0) return candles
    } catch {
      continue
    }
  }
  return []
}

/**
 * Seamless cross-exchange history stitcher (scalpboard.io pattern).
 * Fetches candles from the primary exchange. When data runs out
 * (exchange listed the pair recently), automatically fetches older
 * data from the next-priority exchange and glues the series together.
 * Returns a single deduplicated, time-sorted candle array.
 */
export async function fetchCandlesSeamless(
  symbol: string,
  tf: string,
  limit: number,
  exchange?: Exchange,
  startTime?: number,
  endTime?: number,
  options?: import('../exchanges/types.js').FetchCandlesOptions,
): Promise<UnifiedCandle[]> {
  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  const ordered = exchange
    ? adapters.filter(a => a.exchange === exchange)
    : adaptersByPriority(symbol)
  const targetIdx = ordered.findIndex(a => a.exchange === targetExchange)
  if (targetIdx > 0) { const [t] = ordered.splice(targetIdx, 1); ordered.unshift(t) }

  const allCandles: UnifiedCandle[] = []
  let remaining = limit
  let currentEnd = endTime
  let currentStart = startTime
  const triedExchanges = new Set<string>()

  for (const adapter of ordered) {
    if (remaining <= 0) break
    if (triedExchanges.has(adapter.exchange)) continue
    triedExchanges.add(adapter.exchange)

    try {
      const candles = await adapter.fetchCandles(symbol, tf, remaining, currentStart, currentEnd, options)
      if (candles.length === 0) continue

      allCandles.push(...candles)

      const earliestTime = candles[0].time
      const tfMs = TF_MS_AGGR[tf]
      if (!tfMs) break

      const requested = remaining
      remaining -= candles.length

      // Did this exchange return fewer candles than we asked for?
      // If so, data likely ends here — try next exchange for older history
      if (candles.length < requested) {
        // Keep currentEnd in MILLISECONDS (Binance API expects ms)
        currentEnd = earliestTime * 1000 - tfMs
        // Clear currentStart so next exchange can fetch as far back as it has
        currentStart = undefined
        if (currentEnd <= 0) break
      } else {
        // Got full range — no stitching needed
        break
      }
    } catch (e) {
      // Throttling is transient, NOT end-of-history: propagate it so the
      // history layer fails loudly instead of treating the gap as "the pair
      // has no data" (which permanently starved chart pages of depth).
      if (e instanceof RateLimitError) throw e
      continue
    }
  }

  // Deduplicate by time, keep highest-priority exchange candle for each timestamp
  const byTime = new Map<number, UnifiedCandle>()
  for (const c of allCandles) byTime.set(c.time, c)
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time)
  return sorted.slice(-limit)
}

const TF_MS_AGGR: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000,
  '1d': 86_400_000, '1w': 604_800_000,
}

export async function fetchDepth(symbol: string, limit: number, exchange?: Exchange): Promise<UnifiedDepth | null> {
  const targetExchange = exchange || getTicker(symbol)?.exchange || 'binance-futures'
  const adapter = adapters.find(a => a.exchange === targetExchange)
  if (!adapter) return null
  try {
    return await adapter.fetchDepth(symbol, limit)
  } catch {
    return null
  }
}
