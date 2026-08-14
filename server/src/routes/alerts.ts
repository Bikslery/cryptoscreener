import { Router } from 'express'
import { prisma } from '../db/index.js'
import { validateImpulseCondition, validatePriceCondition, validateListingCondition, VALID_EXCHANGES } from '../services/alerts/validate.js'
import { writeRateLimit } from '../utils/rate-limit.js'

const router = Router()

const writeLimiter = writeRateLimit(60)

router.get('/', async (req, res) => {
  const { userId } = (req as any).user
  const alerts = await prisma.alert.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
  res.json(alerts.map(a => ({ ...a, condition: JSON.parse(a.condition) })))
})

router.post('/', writeLimiter, async (req, res) => {
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

  // Top-level exchange goes through the same whitelist as condition.exchange.
  if (exchange !== undefined && exchange !== null && typeof exchange !== 'string') {
    res.status(400).json({ error: 'exchange: строка' })
    return
  }
  if (typeof exchange === 'string' && !VALID_EXCHANGES.includes(exchange as any)) {
    res.status(400).json({ error: 'exchange: неизвестная биржа' })
    return
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

router.patch('/:id', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const id = String(req.params.id)
  const { active, muted, condition: rawCondition } = req.body

  const existing = await prisma.alert.findFirst({ where: { id, userId } })
  if (!existing) {
    res.status(404).json({ error: 'Алерт не найден' })
    return
  }

  const data: { active?: boolean; muted?: boolean; condition?: string; triggeredAt?: Date | null } = {}
  if (active !== undefined) {
    data.active = Boolean(active)
    data.triggeredAt = active ? null : undefined
  }
  if (muted !== undefined) data.muted = Boolean(muted)

  if (rawCondition !== undefined) {
    let condition: unknown
    if (existing.type === 'impulse') {
      const parsed = validateImpulseCondition(rawCondition)
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error })
        return
      }
      condition = parsed.condition
    } else if (existing.type === 'price') {
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
    data.condition = JSON.stringify(condition)
  }

  const alert = await prisma.alert.update({ where: { id, userId }, data })
  res.json({ ...alert, condition: JSON.parse(alert.condition) })
})

router.delete('/:id', writeLimiter, async (req, res) => {
  const { userId } = (req as any).user
  const id = String(req.params.id)
  await prisma.alert.delete({ where: { id, userId } })
  res.json({ ok: true })
})

export default router
