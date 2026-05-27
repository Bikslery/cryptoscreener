import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { setupWsHub, setCandleManager } from './ws/hub.js'
import { startAggregator, adapters } from './services/aggregator/index.js'
import { startAlertEngine } from './services/alerts/index.js'
import { startTelegramPolling } from './services/telegram/bot.js'
import { createCandleManager } from './services/candles/manager.js'
import authRoutes from './routes/auth.js'
import coinRoutes from './routes/coins.js'
import watchlistRoutes from './routes/watchlists.js'
import alertRoutes from './routes/alerts.js'
import drawingRoutes from './routes/drawings.js'
import { prisma } from './db/index.js'

const PORT = parseInt(process.env.PORT || '3001')

async function main() {
  await prisma.$connect()
  console.log('Database connected')

  const app = express()
  app.use(cors())
  app.use(express.json())

  app.use('/api/auth', authRoutes)
  app.use('/api/coins', coinRoutes)
  app.use('/api/watchlists', watchlistRoutes)
  app.use('/api/alerts', alertRoutes)
  app.use('/api/drawings', drawingRoutes)

  app.get('/api/health', (_req, res) => res.json({ ok: true }))

  const server = createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })

  setupWsHub(wss)
  startAggregator()
  const candleManager = createCandleManager(adapters)
  setCandleManager(candleManager)
  startAlertEngine()
  startTelegramPolling()

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
    console.log(`WebSocket on ws://localhost:${PORT}/ws`)
  })
}

main().catch(console.error)
