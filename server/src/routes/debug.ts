import { Router } from 'express'
import { getCacheStats } from '../services/candles/candle-cache.js'
import { getCandleManagerStats } from '../services/candles/manager.js'
import { getPreloadStats } from '../services/candles/preload.js'

const router = Router()

router.get('/candle-stats', (_req, res) => {
  res.json({
    cache: getCacheStats(),
    subscriptions: getCandleManagerStats(),
    preload: getPreloadStats(),
  })
})

export default router
