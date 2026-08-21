import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { fetchCandles, fetchDepth, getAllTickers, getTickers, getTicker } from '../services/aggregator/index.js'
import { getCachedCandles, setCachedCandlesFromRest, fillGaps } from '../services/candles/candle-cache.js'
import { getHistory } from '../services/candles/history.js'
import { compactCandles } from '../services/candles/compact.js'
import type { Exchange } from '../types.js'

const apiLimiter = rateLimit({
  windowMs: 1000,
  // NB: one page load легально шлёт несколько запросов (bulk + tickers + ...).
  // 10/s душил собственный фронтенд и отдавал 429, которые клиент молча глотал.
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
})

const router = Router()
const SUPPORTED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d', '1w'])
const SUPPORTED_EXCHANGES = new Set<Exchange>(['binance-spot', 'binance-futures', 'bybit-futures'])
const MAX_CANDLE_LIMIT = 3000

/** Route-level timeout for individual history requests. The underlying fetch
 *  keeps running in the background (it populates the cache for the next
 *  request), but the response is bounded so a stalled exchange/Redis never
 *  holds a client connection open indefinitely (axios has no default
 *  timeout). */
const HISTORY_ROUTE_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`route timeout after ${ms}ms`)), ms)
      t.unref?.()
    }),
  ])
}

/**
 * Per-symbol deadline inside candles-bulk. One cold symbol (exchange REST
 * round-trip, rate-limit wait) must not stall the whole 9-chart grid: the
 * bulk answers with whatever settled within this window, unresolved symbols
 * come back as [] and the client tops them up individually (those requests
 * share the same server-side chunk promises via inflightChunks, so they are
 * cheap, not duplicate work).
 */
const BULK_SYMBOL_DEADLINE_MS = 1200

function normalizeExchange(value: unknown): Exchange | undefined {
  if (typeof value !== 'string') return undefined
  return SUPPORTED_EXCHANGES.has(value as Exchange) ? value as Exchange : undefined
}

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, MAX_CANDLE_LIMIT)
}

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}

/**
 * The WS-backed candle cache is a latency fast-path, not an authority. A
 * stalled kline stream (fallback poll gated by exchange throttling) leaves
 * stale tails in it, and serving those permanently starved charts of every
 * recent bar ("empty chart" reports). Only serve the cache when it is fresh
 * enough for the timeframe — otherwise fall through to getHistory, which both
 * returns live data and repopulates the cache on write-back.
 */
function isCacheFresh(candles: Awaited<ReturnType<typeof getHistory>>, tf: string): boolean {
  const last = candles[candles.length - 1]
  if (!last) return false
  const tfSec = TF_SECONDS[tf]
  if (!tfSec) return false
  const stalenessSec = Date.now() / 1000 - last.time
  // Larger timeframes tolerate a longer staleness window — a 4h/1d chart
  // does not need a ≤60s-fresh tail to render correctly.
  return stalenessSec < Math.max(tfSec * 2, 30)
}

// --- Stale-while-revalidate -------------------------------------------------
// When the cache has data but it is stale or shallow, serve it immediately
// and top it up in the background. This keeps charts painting even while the
// exchange rate limiter is throttled — the "never loads until reload" hang
// is replaced by "instant paint of last-known data, refreshed moments later".

const refreshInFlight = new Map<string, { ts: number; promise: Promise<void> }>()

function refreshCandlesInBackground(symbol: string, tf: string, limit: number, exchange?: Exchange): Promise<void> {
  const cacheExchange = exchange || getTicker(symbol)?.exchange
  if (!cacheExchange) return Promise.resolve()
  // Limit is part of the key: a grid's 300-candle refresh must not suppress
  // (or be suppressed by) the expanded chart's 3000-candle one — otherwise
  // the cache stays shallow and the big chart never converges to full depth.
  const k = `${cacheExchange}:${symbol}:${tf}:${limit}`
  const existing = refreshInFlight.get(k)
  if (existing && Date.now() - existing.ts < 2000) return existing.promise

  const attempt = (n: number): Promise<void> => {
    return getHistory(symbol, tf, { limit, exchange, priority: 'background' })
      .then((candles) => {
        if (candles.length > 0) {
          setCachedCandlesFromRest(symbol, tf, candles, cacheExchange || candles[0]?.exchange)
        }
      })
      .catch(() => {
        // Transient failure (rate budget exhausted, exchange throttle): retry
        // with backoff so a failed refresh never leaves the cache shallow
        // forever.
        if (n < 3) {
          return new Promise<void>(r => setTimeout(r, 5000)).then(() => attempt(n + 1))
        }
      })
  }

  const promise = attempt(1).finally(() => {
    if (refreshInFlight.get(k)?.promise === promise) refreshInFlight.delete(k)
  })
  refreshInFlight.set(k, { ts: Date.now(), promise })
  return promise
}

router.use(apiLimiter)

router.get('/', (_req, res) => {
  const tickers = getAllTickers()
  const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  res.setHeader('Cache-Control', 'public, max-age=2')
  res.json(sorted)
})

router.get('/top-symbols', (_req, res) => {
  const tickers = getTickers()
  const top9 = tickers
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, 9)
    .map(t => t.symbol)
  res.setHeader('Cache-Control', 'public, max-age=5')
  res.json(top9)
})

router.post('/candles-bulk', async (req, res) => {
  const { symbols, tf } = req.body as { symbols: string[]; tf: string; limit: number; exchange?: string; compact?: boolean }
  const limit = normalizeLimit(req.body?.limit, 500)
  const exchange = normalizeExchange(req.body?.exchange)
  const compact = req.body?.compact === true
  if (!Array.isArray(symbols) || !tf) {
    res.status(400).json({ error: 'Missing symbols, tf, or limit' })
    return
  }
  if (!SUPPORTED_TIMEFRAMES.has(tf)) {
    res.status(400).json({ error: 'Unsupported timeframe' })
    return
  }
  if (symbols.length > 50) {
    res.status(400).json({ error: 'Too many symbols (max 50)' })
    return
  }
  if (req.body?.exchange && !exchange) {
    res.status(400).json({ error: 'Unsupported exchange' })
    return
  }
  const result: Record<string, any[]> = {}
  const missing: string[] = []

  // Check server in-memory cache first (fastest path) — but only when it is
  // FRESH. A stalled WS stream leaves old tails that starve every grid cell;
  // stale entries fall through to getHistory which heals the cache on write-back.
  for (const symbol of symbols) {
    const ex = exchange || getTicker(symbol)?.exchange
    const cached = getCachedCandles(symbol, tf, ex)
    // Cache is a fast path ONLY when it can fully satisfy the depth: a
    // shallow WS-built cache must not masquerade as the full requested
    // series ("empty-looking" deep charts). Shallow/stale entries fall
    // through to getHistory, which also deepens the cache on write-back.
    if (cached && cached.length >= limit && isCacheFresh(cached, tf)) {
      result[symbol] = cached.slice(-limit)
    } else if (cached && cached.length > 0) {
      // SWR: paint what we have immediately; the background refresh deepens
      // and freshens the cache so the next request (and the client's
      // individual top-up) hits warm data. Never blocks the grid on the
      // exchange round-trip.
      result[symbol] = cached.slice(-limit)
      refreshCandlesInBackground(symbol, tf, limit, ex)
    } else {
      missing.push(symbol)
    }
  }

  // Fetch missing symbols in parallel with seamless cross-exchange history.
  // Each symbol is raced against its own deadline so the response never waits
  // on the slowest one — the grid paints what is ready NOW; the client tops
  // up the rest (individual requests dedupe onto the in-flight chunk fetches).
  if (missing.length > 0) {
    const deadline = Date.now() + BULK_SYMBOL_DEADLINE_MS
    const fetches = missing.map(async (symbol) => {
      const timeLeft = deadline - Date.now()
      const fetchPromise = (async () => {
        try {
          // Explicit exchange requests are strict; auto mode may stitch/fallback.
          const candles = await getHistory(symbol, tf, { limit, exchange })
          if (candles.length > 0) {
            const ex = exchange || getTicker(symbol)?.exchange || candles[0]?.exchange
            setCachedCandlesFromRest(symbol, tf, candles, ex)
          }
          return candles
        } catch {
          return [] as Awaited<ReturnType<typeof getHistory>>
        }
      })()
      const candles = timeLeft > 0
        ? await Promise.race([fetchPromise, new Promise<Awaited<ReturnType<typeof getHistory>>>(resolve => setTimeout(() => resolve([]), timeLeft))])
        : []
      result[symbol] = candles
    })
    await Promise.all(fetches)
  }

  if (compact) {
    // [t,o,h,l,c,v] tuples + per-symbol exchange — ~2-3x smaller payload
    const data: Record<string, { exchange: string | null; candles: ReturnType<typeof compactCandles> }> = {}
    for (const [symbol, candles] of Object.entries(result)) {
      const ex = candles[0]?.exchange || exchange || getTicker(symbol)?.exchange || null
      // Guarantee: never serve a hole — any missing period is bridged with a
      // flat candle here, so the client cannot paint an empty spot.
      const gapless = fillGaps(candles, symbol, ex ?? 'binance-futures', tf)
      data[symbol] = { exchange: ex, candles: compactCandles(gapless) }
    }
    res.json({ format: 'compact', data })
    return
  }

  // Legacy (non-compact) array — apply the same hole-guarantee for safety.
  const legacyResult: Record<string, any[]> = {}
  for (const [symbol, candles] of Object.entries(result)) {
    const ex = candles[0]?.exchange || exchange || getTicker(symbol)?.exchange || null
    legacyResult[symbol] = fillGaps(candles, symbol, ex ?? 'binance-futures', tf)
  }
  res.json(legacyResult)
})

router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = normalizeLimit(req.query.limit, 500)
  const exchange = req.query.exchange as string | undefined
  const before = req.query.before ? parseInt(req.query.before as string) : undefined
  const compact = req.query.compact === '1' || req.query.compact === 'true'

  const send = (candles: Awaited<ReturnType<typeof getHistory>>) => {
    // Hole guarantee: bridge missing periods with flat candles before the
    // response leaves the server, whatever the source (cache fast-path,
    // Redis chunk, exchange fetch).
    const ex: Exchange | null = candles[0]?.exchange || exchange || getTicker(symbol)?.exchange || null
    const gapless = fillGaps(candles, symbol, ex ?? 'binance-futures', tf)
    if (compact) {
      res.json({ format: 'compact', exchange: ex, candles: compactCandles(gapless) })
    } else {
      res.json(gapless)
    }
  }

  if (!SUPPORTED_TIMEFRAMES.has(tf)) {
    res.status(400).json({ error: 'Unsupported timeframe' })
    return
  }

  /**
   * Transient exchange failure (rate-limit 429/418, chunk timeout, hung
   * Redis): serve stale cache when available; otherwise answer 503 so the
   * client keeps retrying instead of painting a permanent "no data" — the
   * exact "stuck until page reload" failure mode.
   */
  const respondTransient = (stale: Awaited<ReturnType<typeof getHistory>> | null) => {
    if (stale && stale.length > 0) {
      res.setHeader('Cache-Control', 'public, max-age=5')
      send(stale)
      return
    }
    res.setHeader('Retry-After', '5')
    res.status(503).json({ error: 'Exchange temporarily unavailable, retry later' })
  }

  if (before !== undefined) {
    try {
      const candles = await withTimeout(getHistory(symbol, tf, { before, limit, exchange: normalizeExchange(exchange) }), HISTORY_ROUTE_TIMEOUT_MS)
      send(candles)
    } catch {
      respondTransient(null)
    }
    return
  }

  const cacheExchange = normalizeExchange(exchange) || getTicker(symbol)?.exchange
  const cached = getCachedCandles(symbol, tf, cacheExchange)
  // Serve the cache only when it can satisfy the REQUESTED depth — a shallow
  // WS-built cache served for a deep request is exactly the "almost empty
  // big chart". Deeper/stale requests fall through to getHistory, which
  // returns full depth and re-deepens the cache on write-back.
  if (cached && cached.length >= limit && isCacheFresh(cached, tf)) {
    res.setHeader('Cache-Control', 'public, max-age=5')
    send(cached.slice(-limit))
    return
  }
  if (cached && cached.length > 0) {
    const shallow = cached.length < limit
    if (shallow) {
      // Shallow cache + deep request (expanded chart): give the refresh a
      // short window so the response carries full depth. Under a rate-limit
      // squeeze the refresh fails fast and we fall through to serving what
      // we have — the client's follow-up top-up converges later.
      try {
        await withTimeout(refreshCandlesInBackground(symbol, tf, limit, cacheExchange), 2500)
        const updated = getCachedCandles(symbol, tf, cacheExchange)
        if (updated && updated.length >= limit) {
          res.setHeader('Cache-Control', 'public, max-age=5')
          send(updated.slice(-limit))
          return
        }
      } catch {
        // refresh window expired — serve shallow below
      }
    } else {
      // Deep-but-stale: SWR — serve now, refresh in the background.
      refreshCandlesInBackground(symbol, tf, limit, cacheExchange)
    }
    // SWR: serve last-known data immediately (even if stale or shallow) and
    // refresh in the background — the chart paints now, the cache heals
    // without holding the response hostage to the exchange round-trip.
    res.setHeader('Cache-Control', 'public, max-age=5')
    send(cached.slice(-limit))
    return
  }

  try {
    const candles = await withTimeout(getHistory(symbol, tf, { limit, exchange: normalizeExchange(exchange) }), HISTORY_ROUTE_TIMEOUT_MS)
    if (candles.length > 0) {
      // Key by the same exchange used for reads/WS updates so cache hits align.
      setCachedCandlesFromRest(symbol, tf, candles, cacheExchange || candles[0]?.exchange)
    }
    send(candles)
  } catch {
    respondTransient(cached ?? null)
  }
})

router.get('/:symbol/depth', async (req, res) => {
  const { symbol } = req.params
  const limit = parseInt(req.query.limit as string) || 20
  const exchange = req.query.exchange as string | undefined
  const depth = await fetchDepth(symbol, limit, normalizeExchange(exchange))
  if (!depth) {
    res.status(404).json({ error: 'Depth not available' })
    return
  }
  res.json(depth)
})

export default router
