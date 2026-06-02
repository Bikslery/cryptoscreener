import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
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

const PORT = parseInt(process.env.PORT || '3001')
const ROLE = process.env.ROLE || 'all'

async function main() {
  try {
    await prisma.$connect()
    console.log('Database connected')
  } catch (e) {
    console.warn('Database unavailable, running without persistence:', e instanceof Error ? e.message : e)
  }

  const app = express()
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }))
  app.set('trust proxy', 1)
  app.use(cookieParser())
  app.use(express.json())

  app.use('/api/auth', authRoutes)
  app.use('/api/coins', coinRoutes)
  app.use('/api/watchlists', watchlistRoutes)
  app.use('/api/alerts', alertRoutes)
  app.use('/api/drawings', drawingRoutes)
  app.use('/api/debug', debugRoutes)

  app.get('/api/health', (_req, res) => res.json({ ok: true, role: ROLE }))

  app.get('/metrics', async (_req, res) => {
    try {
      refreshMetrics()
      res.set('Content-Type', register.contentType)
      res.end(await register.metrics())
    } catch (err) {
      res.status(500).end(err instanceof Error ? err.message : 'metrics error')
    }
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
}

main().catch(console.error)
