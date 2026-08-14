import { Router } from 'express'
import { prisma } from '../db/index.js'
import { writeRateLimit } from '../utils/rate-limit.js'

const router = Router()

const writeLimiter = writeRateLimit(60)

const NAME_MAX = 60
const COINS_MAX = 50
const COIN_SYMBOL_MAX = 32

// Validate a watchlist write before it reaches Prisma: arbitrary/oversized
// payloads (or JSON.stringify(undefined)) must not turn into 500s or DB load.
function parseWatchlistInput(body: any): { name: string; coins: string[] } | { error: string } {
  const { name, coins } = body ?? {}
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > NAME_MAX) {
    return { error: `name: строка от 1 до ${NAME_MAX} символов` }
  }
  if (!Array.isArray(coins) || coins.length > COINS_MAX) {
    return { error: `coins: массив строк (до ${COINS_MAX} элементов)` }
  }
  for (const coin of coins) {
    if (typeof coin !== 'string' || coin.trim() === '' || coin.length > COIN_SYMBOL_MAX) {
      return { error: `coins: каждая позиция — строка до ${COIN_SYMBOL_MAX} символов` }
    }
  }
  return { name: name.trim(), coins }
}

router.get('/', async (req, res) => {
  const { userId } = (req as any).user
  const watchlists = await prisma.watchlist.findMany({ where: { userId } })
  res.json(watchlists.map(w => ({ ...w, coins: JSON.parse(w.coins) })))
})

router.post('/', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const parsed = parseWatchlistInput(req.body)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  const watchlist = await prisma.watchlist.create({
    data: { userId, name: parsed.name, coins: JSON.stringify(parsed.coins) },
  })
  res.json({ ...watchlist, coins: JSON.parse(watchlist.coins) })
})

router.put('/:id', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const id = String(req.params.id)
  const parsed = parseWatchlistInput(req.body)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  const watchlist = await prisma.watchlist.update({
    where: { id, userId },
    data: { name: parsed.name, coins: JSON.stringify(parsed.coins) },
  })
  res.json({ ...watchlist, coins: JSON.parse(watchlist.coins) })
})

router.delete('/:id', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const id = String(req.params.id)
  await prisma.watchlist.delete({ where: { id, userId } })
  res.json({ ok: true })
})

export default router
