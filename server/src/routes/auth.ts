import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../db/index.js'
import { generateToken, authMiddleware, setAuthCookie, clearAuthCookie } from '../middleware/auth.js'

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/

const router = Router()

router.post('/register', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' })
    return
  }
  if (!USERNAME_REGEX.test(username)) {
    res.status(400).json({ error: 'Username must be 3-20 chars, only a-zA-Z0-9_' })
    return
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' })
    return
  }
  const existing = await prisma.user.findUnique({ where: { username } })
  if (existing) {
    res.status(409).json({ error: 'Username already taken' })
    return
  }
  const passwordHash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({
    data: { username, passwordHash, telegramVerified: false },
  })
  const token = generateToken({ userId: user.id, username: user.username })
  setAuthCookie(res, token)
  res.json({
    user: { id: user.id, username: user.username, telegramVerified: user.telegramVerified },
  })
})

router.post('/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' })
    return
  }
  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  const token = generateToken({ userId: user.id, username: user.username })
  setAuthCookie(res, token)
  res.json({
    user: { id: user.id, username: user.username, telegramVerified: user.telegramVerified },
  })
})

router.post('/logout', (_req, res) => {
  clearAuthCookie(res)
  res.json({ ok: true })
})

router.get('/me', authMiddleware, async (req, res) => {
  const { userId } = (req as any).user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, telegramChatId: true, telegramVerified: true, settings: true },
  })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (user.settings) {
    res.json({ ...user, settings: JSON.parse(user.settings) })
  } else {
    res.json(user)
  }
})

router.get('/telegram-status', authMiddleware, async (req, res) => {
  const { userId } = (req as any).user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramVerified: true, id: true },
  })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  const telegramLink = `https://t.me/clinic_screenerbot?start=bind_${user.id}`
  res.json({ telegramVerified: user.telegramVerified, telegramLink })
})

export default router
