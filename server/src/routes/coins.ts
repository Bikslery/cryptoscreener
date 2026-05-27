import { Router } from 'express'
import { getTickers, fetchCandles, fetchDepth } from '../services/aggregator/index.js'
import {
  getCachedCandles,
  setCachedCandles,
  setCachedCandlesFromRest,
} from '../services/candles/candle-cache.js'

const router = Router()

router.get('/', (_req, res) => {
  const tickers = getTickers()
  const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  res.json(sorted)
})

// POST /candles-bulk — bulk fetch candles for multiple symbols
router.post('/candles-bulk', async (req, res) => {
  const { symbols, tf, limit } = req.body as { symbols: string[]; tf: string; limit: number }
  if (!Array.isArray(symbols) || !tf || !limit) {
    res.status(400).json({ error: 'Missing symbols, tf, or limit' })
    return
  }

  const result: Record<string, any[]> = {}
  const promises = symbols.map(async (symbol) => {
    const cached = getCachedCandles(symbol, tf)
    if (cached && cached.length >= limit) {
      result[symbol] = cached.slice(cached.length - limit)
      return
    }

    // Not cached or too short: fetch from REST
    const candles = await fetchCandles(symbol, tf, limit)
    if (candles.length > 0) {
      setCachedCandlesFromRest(symbol, tf, candles)
    }
    result[symbol] = candles
  })

  await Promise.all(promises)
  res.json(result)
})

// GET /top-symbols — returns top-9 symbols by quoteVolume24h
router.get('/top-symbols', (_req, res) => {
  const tickers = getTickers()
  const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  const top9 = sorted.slice(0, 9).map(t => t.symbol)
  res.json(top9)
})

router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = parseInt(req.query.limit as string) || 500
  const exchange = req.query.exchange as string | undefined

  // Check cache first
  const cached = getCachedCandles(symbol, tf)
  if (cached && cached.length >= limit) {
    res.json(cached.slice(cached.length - limit))
    return
  }

  // Not cached or too short: fetch from REST
  const candles = await fetchCandles(symbol, tf, limit, exchange as any)
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
