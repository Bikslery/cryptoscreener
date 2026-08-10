import express from 'express'
import compression from 'compression'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import type { Request, Response, NextFunction } from 'express'
import { setupWsHub, setCandleManager, startRedisListener, stopWsHub, refreshMetrics } from './ws/hub.js'
import { startAggregator, adapters } from './services/aggregator/index.js'
import { startAlertEngine, stopAlertEngine } from './services/alerts/index.js'
import { startTelegramPolling } from './services/telegram/bot.js'
import { createCandleManager } from './services/candles/manager.js'
import { startPreload } from './services/candles/preload.js'
import authRoutes from './routes/auth.js'
import coinRoutes from './routes/coins.js'
import watchlistRoutes from './routes/watchlists.js'
import alertRoutes from './routes/alerts.js'
import drawingRoutes from './routes/drawings.js'
import debugRoutes from './routes/debug.js'
import { prisma } from './db/index.js'
import { disconnectRedis } from './redis.js'
import { register } from './metrics.js'
import { authMiddleware } from './middleware/auth.js'

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
  app.use('/api/watchlists', watchlistRoutes)
  app.use('/api/alerts', alertRoutes)
  app.use('/api/drawings', drawingRoutes)
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
    console.error('[Error]', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  })

  const server = createServer(app)

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    perMessageDeflate: {
      zlibDeflateOptions: { level: 3 },
      zlibInflateOptions: { chunkSize: 16 * 1024 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      threshold: 1024,
    },
  })

  const isIngestion = ROLE === 'ingestion' || ROLE === 'all'
  const isBroadcast = ROLE === 'broadcast' || ROLE === 'all'

  setupWsHub(wss)

  if (isIngestion) {
    startAggregator()
    const candleManager = createCandleManager(adapters)
    setCandleManager(candleManager)
    startPreload(adapters, candleManager)
    startAlertEngine()
    startTelegramPolling()
    console.log('[Role] Ingestion + Broadcast (all-in-one)')
  }

  if (isBroadcast && !isIngestion) {
    startRedisListener()
    const candleManager = createCandleManager(adapters)
    setCandleManager(candleManager)
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
    stopAlertEngine()
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
