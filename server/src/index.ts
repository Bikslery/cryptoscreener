import express from 'express'
import compression from 'compression'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import type { Request, Response, NextFunction } from 'express'
import { setupWsHub, setCandleManager, startRedisListener, startIngestionRedisListener, stopWsHub, refreshMetrics } from './ws/hub.js'
import { startAggregator, adapters } from './services/aggregator/index.js'
import { flushTradeLane } from './services/trades/aggTrade.js'
import { flushCandleLane } from './services/candles/manager.js'
import { startAlertEngine, stopAlertEngine } from './services/alerts/index.js'
import { startTelegramPolling } from './services/telegram/bot.js'
import { createCandleManager, createRemoteCandleManager } from './services/candles/manager.js'
import { startPreload } from './services/candles/preload.js'
import { flushHistoryChunkCache } from './services/candles/history.js'
import { startCacheRepairWatchdog } from './services/candles/repair.js'
import authRoutes from './routes/auth.js'
import coinRoutes from './routes/coins.js'
import watchlistRoutes from './routes/watchlists.js'
import alertRoutes from './routes/alerts.js'
import drawingRoutes from './routes/drawings.js'
import debugRoutes from './routes/debug.js'
import densityRoutes from './routes/density.js'
import { startDensityService, stopDensityService } from './services/density/index.js'
import { OkxSpotAdapter } from './services/exchanges/okx-spot.js'
import { prisma } from './db/index.js'
import { disconnectRedis } from './redis.js'
import { register } from './metrics.js'
import { authMiddleware, requireTelegramVerified } from './middleware/auth.js'

const PORT = parseInt(process.env.PORT || '3001')
const ROLE = process.env.ROLE || 'all'

// Undici (Node's bundled HTTP client) can throw an uncaught ERR_ASSERTION
// from its H1 parser when a remote exchange (Binance etc.) drops the
// connection mid-response. The crash is `AssertionError [ERR_ASSERTION]:
// false == true` in undici/lib/dispatcher/client-h1.js — a known undici
// fragility with aborted keep-alive connections. It is not a bug in our
// code and never affects a second request (a fresh connection is used), but
// it kills the whole process. Catch only that exact class and let the
// request's own timeout/retry machinery handle the failure; everything else
// still crashes loudly.
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? (err.stack ?? '') : ''
  const isUndiciParserAssertion =
    (err as NodeJS.ErrnoException).code === 'ERR_ASSERTION' &&
    msg.includes('false == true') &&
    stack.includes('undici')
  if (isUndiciParserAssertion) {
    console.warn('[process] Swallowed undici parser assertion (remote dropped connection):', msg)
    return
  }
  console.error('[process] Uncaught exception:', err)
  process.exit(1)
})

async function main() {
  try {
    await prisma.$connect()
    console.log('Database connected')
  } catch (e) {
    console.warn('Database unavailable, running without persistence:', e instanceof Error ? e.message : e)
  }

  const app = express()
  // Gzip API responses. In prod nginx also gzips, but this covers direct
  // access and the dev vite proxy; candle payloads are highly compressible.
  app.use(compression())
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }))
  app.set('trust proxy', 1)
  app.use(cookieParser())
  app.use(express.json())

  app.use('/api/auth', authRoutes)
  app.use('/api/coins', coinRoutes)
  // Telegram binding is mandatory: users without a bound Telegram account are
  // locked out of every app feature (watchlists, alerts, drawings, settings).
  app.use('/api/watchlists', authMiddleware, requireTelegramVerified, watchlistRoutes)
  app.use('/api/alerts', authMiddleware, requireTelegramVerified, alertRoutes)
  app.use('/api/drawings', authMiddleware, requireTelegramVerified, drawingRoutes)
  app.use('/api/density', authMiddleware, requireTelegramVerified, densityRoutes)
  app.use('/api/debug', authMiddleware, debugRoutes)

  app.use('/api/health', (_req, res) => res.json({ ok: true, role: ROLE }))

  app.get('/metrics', authMiddleware, async (_req, res) => {
    try {
      refreshMetrics()
      res.set('Content-Type', register.contentType)
      res.end(await register.metrics())
    } catch (err) {
      res.status(500).end(err instanceof Error ? err.message : 'metrics error')
    }
  })

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    // Log the full error server-side, never leak internals (Prisma messages,
    // stack traces) to the client.
    console.error('[Error]', err)
    res.status(500).json({ error: 'Internal server error' })
  })

  const server = createServer(app)

  // Frames are deflate-raw compressed explicitly (see hub.encodePayload), so
  // perMessageDeflate is disabled to avoid double compression.
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false })

  const isIngestion = ROLE === 'ingestion' || ROLE === 'all'
  const isBroadcast = ROLE === 'broadcast' || ROLE === 'all'

  // Chunks written while an exchange was throttled/geo-blocked may be partial
  // or from the wrong exchange; clearing the pure-cache chunk store on boot
  // guarantees history never serves those holes again (they refetch on demand).
  await flushHistoryChunkCache()

  let okxDepthAdapter: OkxSpotAdapter | null = null

  if (isBroadcast) setupWsHub(wss)

  if (isIngestion) {
    startAggregator()
    const candleManager = createCandleManager(adapters)
    setCandleManager(candleManager)
    startPreload(adapters, candleManager)
    // Guarantee "no holes ever": periodic audit+repair of the candle cache
    // (plus instant repair on inbound WS gap detection in the manager).
    startCacheRepairWatchdog()
    startAlertEngine()
    startTelegramPolling()
    // Density (orderbook walls) engine — subscribes depth for top-N symbols
    // across all exchanges and broadcasts the global snapshot every ~2s.
    // OKX spot joins density only (its ticker feed isn't wired into the
    // aggregator yet), on its own adapter instance.
    okxDepthAdapter = new OkxSpotAdapter()
    okxDepthAdapter.connect()
    startDensityService([...adapters, okxDepthAdapter])
    // Broadcast nodes forward client candle/depth subscriptions here via Redis.
    startIngestionRedisListener()
    console.log(`[Role] Ingestion node${isBroadcast ? ' + Broadcast (all-in-one)' : ''}`)
  }

  if (isBroadcast && !isIngestion) {
    startRedisListener()
    // Broadcast node never connects to the exchanges — realtime data comes via
    // Redis; client subscriptions are forwarded to the ingestion node.
    setCandleManager(createRemoteCandleManager())
    console.log('[Role] Broadcast worker (reading from Redis)')
  }

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} (role=${ROLE})`)
    console.log(`WebSocket on ws://localhost:${PORT}/ws [compression enabled]`)
  })

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Graceful shutdown...`)
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.close(1001, 'server shutting down')
    })
    for (const adapter of adapters) adapter.disconnect()
    if (okxDepthAdapter) okxDepthAdapter.disconnect()
    flushTradeLane()
    flushCandleLane()
    stopAlertEngine()
    stopDensityService()
    stopWsHub()
    server.close()
    await disconnectRedis()
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => {
    console.error('[Fatal] Unhandled promise rejection:', reason)
  })
}

main().catch(console.error)
