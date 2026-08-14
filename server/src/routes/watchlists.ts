import { Router } from 'express'
import { prisma } from '../db/index.js'

const router = Router()

router.get('/', async (req, res) => {
  const { userId } = (req as any).user
  const watchlists = await prisma.watchlist.findMany({ where: { userId } })
  res.json(watchlists.map(w => ({ ...w, coins: JSON.parse(w.coins) })))
})

router.post('/', async (req, res) => {
  const { userId } = (req as any).user
  const { name, coins } = req.body
  const watchlist = await prisma.watchlist.create({
    data: { userId, name, coins: JSON.stringify(coins || []) },
  })
  res.json({ ...watchlist, coins: JSON.parse(watchlist.coins) })
})

router.put('/:id', async (req, res) => {
  const { userId } = (req as any).user
  const { id } = req.params
  const { name, coins } = req.body
  const watchlist = await prisma.watchlist.update({
    where: { id, userId },
    data: { name, coins: JSON.stringify(coins) },
  })
  res.json({ ...watchlist, coins: JSON.parse(watchlist.coins) })
})

router.delete('/:id', async (req, res) => {
  const { userId } = (req as any).user
  const { id } = req.params
  await prisma.watchlist.delete({ where: { id, userId } })
  res.json({ ok: true })
})

export default router
