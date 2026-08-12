import { Router } from 'express'
import { getCacheStats, getCachedCandles, fillGaps, getSyntheticFillCount } from '../services/candles/candle-cache.js'
import { getCandleManagerStats, getCandleDiagStats } from '../services/candles/manager.js'
import { getPreloadStats } from '../services/candles/preload.js'
import { getHubStats } from '../ws/hub.js'
import { getCandleFallbackDiagStats } from '../services/exchanges/binance-futures.js'
import { getHistory } from '../services/candles/history.js'
import { fetchCandlesSeamless } from '../services/aggregator/index.js'
import { getCacheRepairStats } from '../services/candles/repair.js'
import type { Exchange } from '../types.js'

const router = Router()

const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}

/** Adjacent-candle gaps (periods with no candle) inside a sorted series. */
function findHoles(candles: { time: number }[], tfSec: number) {
  const holes: { from: number; to: number; periods: number }[] = []
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].time - candles[i - 1].time
    if (diff > tfSec * 1.5) {
      holes.push({
        from: candles[i - 1].time + tfSec,
        to: candles[i].time - tfSec,
        periods: Math.round(diff / tfSec) - 1,
      })
      if (holes.length >= 50) break
    }
  }
  return holes
}

// DIAGNOSTIC (read-only): fetch a candle window the EXACT way the app does and
// report continuity holes. mode=exchange skips caches and hits the exchange
// adapter directly (source of truth); mode=cache reads the raw in-memory cache
// (the source that was serving holes) and shows how many synthetic flats the
// serve-time fill would add. Use this right after a user spots an "empty
// place" to decide server-vs-wire/client.
//   GET /api/debug/history-check?symbol=BTCUSDT&tf=5m&limit=300&mode=app
//   GET /api/debug/history-check?symbol=BTCUSDT&tf=5m&limit=300&mode=exchange&exchange=binance-futures
//   GET /api/debug/history-check?symbol=BTCUSDT&tf=5m&limit=1000&mode=cache&exchange=binance-futures
router.get('/history-check', async (req, res) => {
  const symbol = String(req.query.symbol ?? '')
  const tf = String(req.query.tf ?? '')
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '300'), 10) || 300, 2), 3000)
  const exchange = (req.query.exchange as Exchange | undefined) || undefined
  const mode = req.query.mode === 'exchange' ? 'exchange' : req.query.mode === 'cache' ? 'cache' : 'app'
  const before = req.query.before ? parseInt(String(req.query.before), 10) : undefined
  const tfSec = TF_SECONDS[tf]
  if (!symbol || !tfSec) {
    res.status(400).json({ error: 'symbol and a supported tf are required' })
    return
  }

  const startedAt = Date.now()
  const base = {
    symbol,
    tf,
    exchange: exchange ?? 'auto',
    before: before ?? null,
    requestedLimit: limit,
    elapsedMs: 0,
  }

  // mode=cache reads the raw memory cache (what the app's routes would serve
  // through the fast-path) and reports its holes + the fill that delivery adds.
  if (mode === 'cache') {
    const raw = getCachedCandles(symbol, tf, exchange)
    if (!raw) {
      res.json({ ...base, mode, error: null, total: 0, holesCount: 0, holes: [], servedFlatCount: 0, rawTotal: 0, elapsedMs: Date.now() - startedAt })
      return
    }
    const sorted = [...raw].sort((a, b) => a.time - b.time).slice(-limit)
    const rawHoles = findHoles(sorted, tfSec)
    const gapless = fillGaps(sorted, symbol, exchange ?? 'binance-futures', tf)
    res.json({
      ...base,
      mode,
      error: null,
      total: sorted.length,
      rawTotal: sorted.length,
      firstTime: sorted.length > 0 ? sorted[0].time : null,
      lastTime: sorted.length > 0 ? sorted[sorted.length - 1].time : null,
      holesCount: rawHoles.length,
      holes: rawHoles,
      // how many synthetic flat candles the serve-time hole-guarantee adds
      servedFlatCount: gapless.length - sorted.length,
      elapsedMs: Date.now() - startedAt,
    })
    return
  }

  let candles: Awaited<ReturnType<typeof getHistory>> = []
  let error: string | null = null
  try {
    candles = mode === 'exchange'
      ? await fetchCandlesSeamless(symbol, tf, limit, exchange)
      : await getHistory(symbol, tf, { limit, exchange, before })
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const sorted = candles.length > 1 ? [...candles].sort((a, b) => a.time - b.time) : candles
  const holes = findHoles(sorted, tfSec)

  res.json({
    ...base,
    mode,
    error,
    total: sorted.length,
    firstTime: sorted.length > 0 ? sorted[0].time : null,
    lastTime: sorted.length > 0 ? sorted[sorted.length - 1].time : null,
    holesCount: holes.length,
    holes,
    elapsedMs: Date.now() - startedAt,
  })
})

router.get('/candle-stats', (_req, res) => {
  res.json({
    cache: getCacheStats(),
    subscriptions: getCandleManagerStats(),
    preload: getPreloadStats(),
    // DIAGNOSTICS
    candleContinuity: getCandleDiagStats(),
    candleFallback: getCandleFallbackDiagStats(),
    candleRepair: getCacheRepairStats(),
    syntheticFilled: getSyntheticFillCount(),
  })
})

router.get('/ws-stats', (_req, res) => {
  res.json(getHubStats())
})

export default router
