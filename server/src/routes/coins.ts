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
const SUPPORTED_TIMEFRAMES = new Set(['1s', '5s', '15s', '1m', '5m', '15m', '1h', '4h', '1d', '1w'])
const SUPPORTED_EXCHANGES = new Set<Exchange>(['binance-spot', 'binance-futures', 'bybit-futures'])
const MAX_CANDLE_LIMIT = 3000

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
  '1s': 1, '5s': 5, '15s': 15,
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
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
  return stalenessSec < Math.max(tfSec * 2, 30)
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
    } else {
      missing.push(symbol)
    }
  }

  // Fetch missing symbols in parallel with seamless cross-exchange history
  if (missing.length > 0) {
    const fetches = missing.map(async (symbol) => {
      try {
        // Explicit exchange requests are strict; auto mode may stitch/fallback.
        const candles = await getHistory(symbol, tf, { limit, exchange })
        if (candles.length > 0) {
          const ex = exchange || getTicker(symbol)?.exchange || candles[0]?.exchange
          setCachedCandlesFromRest(symbol, tf, candles, ex)
          result[symbol] = candles
        } else {
          result[symbol] = []
        }
      } catch {
        result[symbol] = []
      }
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

  if (before !== undefined) {
    const candles = await getHistory(symbol, tf, { before, limit, exchange: normalizeExchange(exchange) })
    send(candles)
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

  const candles = await getHistory(symbol, tf, { limit, exchange: normalizeExchange(exchange) })
  if (candles.length > 0) {
    // Key by the same exchange used for reads/WS updates so cache hits align.
    setCachedCandlesFromRest(symbol, tf, candles, cacheExchange || candles[0]?.exchange)
  }
  send(candles)
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
