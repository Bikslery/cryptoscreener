import { Router } from 'express'
import { getTickers, fetchCandles, fetchDepth } from '../services/aggregator/index.js'
import { getCachedCandles, setCachedCandlesFromRest } from '../services/candles/candle-cache.js'

const router = Router()

router.get('/', (_req, res) => {
  const tickers = getTickers()
  const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  res.json(sorted)
})

router.get('/top-symbols', (_req, res) => {
  const tickers = getTickers()
  const top9 = tickers
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, 9)
    .map(t => t.symbol)
  res.json(top9)
})

router.post('/candles-bulk', async (req, res) => {
  const { symbols, tf, limit } = req.body as { symbols: string[]; tf: string; limit: number }
  if (!Array.isArray(symbols) || !tf || !limit) {
    res.status(400).json({ error: 'Missing symbols, tf, or limit' })
    return
  }
  const result: Record<string, any[]> = {}
  const missing: string[] = []

  for (const symbol of symbols) {
    const cached = getCachedCandles(symbol, tf)
    if (cached && cached.length > 0) {
      result[symbol] = cached.slice(-limit)
    } else {
      missing.push(symbol)
    }
  }

  if (missing.length > 0) {
    const fetches = missing.map(async (symbol) => {
      try {
        const candles = await fetchCandles(symbol, tf, limit)
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
  const limit = parseInt(req.query.limit as string) || 500
  const exchange = req.query.exchange as string | undefined
  const startTime = req.query.startTime ? parseInt(req.query.startTime as string) : undefined
  const endTime = req.query.endTime ? parseInt(req.query.endTime as string) : undefined

  if (startTime !== undefined || endTime !== undefined) {
    const candles = await fetchCandles(symbol, tf, limit, exchange as any, startTime, endTime)
    res.json(candles)
    return
  }

  // Cache-first
  const cached = getCachedCandles(symbol, tf)
  if (cached && cached.length > 0) {
    res.json(cached.slice(-limit))
    return
  }

  // Fallback: fetch from adapter
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
