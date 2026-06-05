import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { prisma } from '../db/index.js'
import { generateToken, authMiddleware, setAuthCookie, clearAuthCookie, generateResetToken, verifyResetToken } from '../middleware/auth.js'
import { sendTelegramMessage } from '../services/telegram/bot.js'

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window per IP
  message: { error: 'Too many attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false,
})

const resetVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false,
})

const router = Router()

router.post('/register', authLimiter, async (req, res) => {
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

router.post('/login', authLimiter, async (req, res) => {
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
    select: { telegramVerified: true, id: true, telegramBindError: true },
  })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  const telegramLink = `https://t.me/clinic_screenerbot?start=bind_${user.id}`
  res.json({ telegramVerified: user.telegramVerified, telegramLink, telegramBindError: user.telegramBindError })
})

// ── Password reset: request code via Telegram ──

router.post('/reset-request', authLimiter, async (req, res) => {
  const { username, userId } = req.body
  if (!username && !userId) {
    res.status(400).json({ error: 'Username or userId required' })
    return
  }

  let user: any
  if (username) {
    user = await prisma.user.findUnique({ where: { username } })
  } else {
    user = await prisma.user.findUnique({ where: { id: userId } })
  }

  if (!user) {
    res.status(404).json({ error: 'Пользователь не найден' })
    return
  }

  if (!user.telegramVerified || !user.telegramChatId) {
    res.status(400).json({ error: 'Telegram не привязан. Сначала привяжите Telegram.' })
    return
  }

  // Rate limit: 1 request per 60 seconds
  const recent = await prisma.passwordReset.findFirst({
    where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60_000) } },
    orderBy: { createdAt: 'desc' },
  })
  if (recent) {
    res.status(429).json({ error: 'Подождите минуту перед повторной отправкой' })
    return
  }

  // Invalidate any previous unused codes
  await prisma.passwordReset.updateMany({
    where: { userId: user.id, used: false },
    data: { used: true },
  })

  const code = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + 5 * 60_000)

  await prisma.passwordReset.create({
    data: { userId: user.id, code, expiresAt },
  })

  const sent = await sendTelegramMessage(
    user.telegramChatId,
    `🔑 Код для сброса пароля: <b>${code}</b>\nДействителен 5 минут.`
  )

  if (!sent) {
    res.status(500).json({ error: 'Не удалось отправить код в Telegram' })
    return
  }

  res.json({ ok: true, userId: user.id })
})

// ── Password reset: verify code ──

router.post('/reset-verify', resetVerifyLimiter, async (req, res) => {
  const { userId, code } = req.body
  if (!userId || !code) {
    res.status(400).json({ error: 'userId и код обязательны' })
    return
  }

  const reset = await prisma.passwordReset.findFirst({
    where: {
      userId,
      code,
      used: false,
      expiresAt: { gt: new Date() },
    },
  })

  if (!reset) {
    res.status(400).json({ error: 'Неверный или истёкший код' })
    return
  }

  // Mark code as used
  await prisma.passwordReset.update({
    where: { id: reset.id },
    data: { used: true },
  })

  const resetToken = generateResetToken(userId)
  res.json({ resetToken })
})

// ── Password reset: set new password ──

router.post('/reset-password', async (req, res) => {
  const { resetToken, password } = req.body
  if (!resetToken || !password) {
    res.status(400).json({ error: 'Токен и пароль обязательны' })
    return
  }

  const userId = verifyResetToken(resetToken)
  if (!userId) {
    res.status(401).json({ error: 'Токен сброса недействителен или истёк' })
    return
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' })
    return
  }

  const passwordHash = await bcrypt.hash(password, 10)
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  })

  res.json({ ok: true })
})

export default router
