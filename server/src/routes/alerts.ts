import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { prisma } from '../db/index.js'
import { validateImpulseCondition, validatePriceCondition, validateListingCondition } from '../services/alerts/validate.js'

const router = Router()

router.use(authMiddleware)

router.get('/', async (req, res) => {
  const { userId } = (req as any).user
  const alerts = await prisma.alert.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
  res.json(alerts.map(a => ({ ...a, condition: JSON.parse(a.condition) })))
})

router.post('/', async (req, res) => {
  const { userId } = (req as any).user
  const { type, symbol, exchange, condition: rawCondition } = req.body

  if (typeof type !== 'string' || !['price', 'impulse', 'listing'].includes(type)) {
    res.status(400).json({ error: 'Неизвестный тип алерта' })
    return
  }
  if (typeof symbol !== 'string' || symbol.trim() === '' || symbol.length > 32) {
    res.status(400).json({ error: 'symbol обязателен (до 32 символов)' })
    return
  }

  let condition: unknown
  if (type === 'impulse') {
    const parsed = validateImpulseCondition(rawCondition)
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }
    condition = parsed.condition
  } else if (type === 'price') {
    const parsed = validatePriceCondition(rawCondition)
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }
    condition = parsed.condition
  } else {
    const parsed = validateListingCondition(rawCondition)
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }
    condition = parsed.condition
  }

  const alert = await prisma.alert.create({
    data: {
      userId,
      type,
      symbol: type === 'impulse' ? (symbol.trim().toUpperCase() || 'ANY') : symbol.trim().toUpperCase(),
      exchange: typeof exchange === 'string' ? exchange : null,
      condition: JSON.stringify(condition),
    },
  })
  res.json({ ...alert, condition: JSON.parse(alert.condition) })
})

router.patch('/:id', async (req, res) => {
  const { userId } = (req as any).user
  const { id } = req.params
  const { active, muted } = req.body
  const alert = await prisma.alert.update({
    where: { id, userId },
    data: { active, muted, triggeredAt: active ? null : undefined },
  })
  res.json({ ...alert, condition: JSON.parse(alert.condition) })
})

router.delete('/:id', async (req, res) => {
  const { userId } = (req as any).user
  const { id } = req.params
  await prisma.alert.delete({ where: { id, userId } })
  res.json({ ok: true })
})

export default router
