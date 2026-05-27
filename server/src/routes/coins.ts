import { Router } from 'express'
import { getTickers, fetchCandles, fetchDepth } from '../services/aggregator/index.js'

const router = Router()

router.get('/', (_req, res) => {
  const tickers = getTickers()
  const sorted = tickers.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  res.json(sorted)
})

router.get('/:symbol/candles', async (req, res) => {
  const { symbol } = req.params
  const tf = (req.query.tf as string) || '1m'
  const limit = parseInt(req.query.limit as string) || 500
  const exchange = req.query.exchange as string | undefined
  const candles = await fetchCandles(symbol, tf, limit, exchange as any)
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
