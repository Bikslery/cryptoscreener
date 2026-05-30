import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { fetchCandles, fetchDepth, getTickers } from '../services/aggregator/index.js'
import { getCachedCandles, setCachedCandlesFromRest } from '../services/candles/candle-cache.js'
import { getHistory } from '../services/candles/history.js'

const apiLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
})

const router = Router()
const SUPPORTED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d', '1w'])
const MAX_CANDLE_LIMIT = 1000

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, MAX_CANDLE_LIMIT)
}

router.use(apiLimiter)

router.get('/', (_req, res) => {
  const tickers = getTickers()
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
  const { symbols, tf } = req.body as { symbols: string[]; tf: string; limit: number }
  const limit = normalizeLimit(req.body?.limit, 500)
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
  const result: Record<string, any[]> = {}
  const missing: string[] = []

  // Check server in-memory cache first (fastest path)
  for (const symbol of symbols) {
    const cached = getCachedCandles(symbol, tf)
    if (cached && cached.length > 0) {
      result[symbol] = cached.slice(-limit)
    } else {
      missing.push(symbol)
    }
  }

  // Fetch missing symbols in parallel with seamless cross-exchange history
  if (missing.length > 0) {
    const fetches = missing.map(async (symbol) => {
      try {
        // getHistory now uses fetchCandlesSeamless internally —
        // automatically stitches data from multiple exchanges
        const candles = await getHistory(symbol, tf, { limit })
        if (candles.length > 0) {
          setCachedCandlesFromRest(symbol, tf, candles)
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

  res.json(result)
})

router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = normalizeLimit(req.query.limit, 500)
  const exchange = req.query.exchange as string | undefined
  const before = req.query.before ? parseInt(req.query.before as string) : undefined

  if (!SUPPORTED_TIMEFRAMES.has(tf)) {
    res.status(400).json({ error: 'Unsupported timeframe' })
    return
  }

  if (before !== undefined) {
    const candles = await getHistory(symbol, tf, { before, limit, exchange: exchange as any })
    res.json(candles)
    return
  }

  const cached = getCachedCandles(symbol, tf)
  const minUsable = Math.min(Math.floor(limit * 0.5), 100)
  if (cached && cached.length >= minUsable) {
    res.setHeader('Cache-Control', 'public, max-age=5')
    res.json(cached.slice(-limit))
    return
  }

  const candles = await getHistory(symbol, tf, { limit, exchange: exchange as any })
  if (candles.length > 0) {
    setCachedCandlesFromRest(symbol, tf, candles)
  }
  res.json(candles)
})

router.get('/:symbol/depth', async (req, res) => {
  const { symbol } = req.params
  const limit = parseInt(req.query.limit as string) || 20
  const exchange = req.query.exchange as string | undefined
  const depth = await fetchDepth(symbol, limit, exchange as any)
  if (!depth) {
    res.status(404).json({ error: 'Depth not available' })
    return
  }
  res.json(depth)
})

export default router
