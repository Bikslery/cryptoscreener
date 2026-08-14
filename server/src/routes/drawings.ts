import { Router } from 'express'
import { prisma } from '../db/index.js'
import { writeRateLimit } from '../utils/rate-limit.js'

const router = Router()

// Wider budget: the client saves drawings with a debounce after every drag.
const writeLimiter = writeRateLimit(120)

router.get('/', async (req, res) => {
  const { userId } = (req as any).user
  const { symbol } = req.query
  const where: any = { userId }
  if (symbol) where.symbol = symbol
  const drawings = await prisma.drawing.findMany({ where })
  res.json(drawings.map(d => ({ ...d, data: JSON.parse(d.data) })))
})

router.post('/', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const { symbol, type, data, timeframe } = req.body
  const drawing = await prisma.drawing.create({
    data: { userId, symbol, timeframe: timeframe || '', type, data: JSON.stringify(data) },
  })
  res.json({ ...drawing, data: JSON.parse(drawing.data) })
})

router.put('/:id', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const id = String(req.params.id)
  const { data, timeframe } = req.body
  const drawing = await prisma.drawing.update({
    where: { id, userId },
    data: { data: JSON.stringify(data), timeframe: timeframe || undefined },
  })
  res.json({ ...drawing, data: JSON.parse(drawing.data) })
})

router.delete('/:id', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const id = String(req.params.id)
  await prisma.drawing.delete({ where: { id, userId } })
  res.json({ ok: true })
})

export default router
