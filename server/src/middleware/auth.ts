import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../db/index.js'

const JWT_SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('JWT_SECRET env var is required in production') })()
    : 'change-me-in-production'
)
const RESET_JWT_SECRET = process.env.RESET_JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('RESET_JWT_SECRET env var is required in production') })()
    : 'change-me-reset-secret'
)
const COOKIE_NAME = 'token'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 days in ms
const REFRESH_THRESHOLD = 24 * 60 * 60 * 1000 // refresh if < 1 day left
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || (
  process.env.COOKIE_SECURE === undefined && process.env.NODE_ENV === 'production'
)

export interface JwtPayload {
  userId: string
  username: string
}

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload
  } catch {
    return null
  }
}

// Token is valid AND the user's Telegram is bound. Used by the WS hub so
// unverified users cannot receive market data streams at all.
export async function verifyTokenWithTelegram(token: string): Promise<JwtPayload | null> {
  const payload = verifyToken(token)
  if (!payload) return null
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { telegramVerified: true },
    })
    if (!user?.telegramVerified) return null
    return payload
  } catch (err) {
    console.error('[auth] verifyTokenWithTelegram failed:', err)
    return null
  }
}

export function generateResetToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'password-reset' }, RESET_JWT_SECRET, { expiresIn: '10m' })
}

export function verifyResetToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, RESET_JWT_SECRET) as any
    if (payload.purpose !== 'password-reset') return null
    return payload.userId as string
  } catch {
    return null
  }
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  })
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: '/' })
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Read token from cookie first, fallback to Authorization header
  let token = req.cookies?.[COOKIE_NAME]
  if (!token) {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7)
    }
  }

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const payload = verifyToken(token)
  if (!payload) {
    res.status(401).json({ error: 'Invalid token' })
    return
  }

  ;(req as any).user = payload

  // Auto-refresh: if token expires in < 1 day, issue a new one
  try {
    const decoded = jwt.decode(token) as any
    if (decoded?.exp) {
      const expiresAt = decoded.exp * 1000
      const now = Date.now()
      if (expiresAt - now < REFRESH_THRESHOLD) {
        const newToken = generateToken({ userId: payload.userId, username: payload.username })
        setAuthCookie(res, newToken)
      }
    }
  } catch {
    // ignore refresh errors
  }

  next()
}

// Hard gate: authenticated users whose Telegram is not bound are locked out of
// the app. The check reads the DB (source of truth), because binding happens in
// the Telegram bot which updates the row without touching the JWT — a token
// claim would go stale the moment the user binds.
export async function requireTelegramVerified(req: Request, res: Response, next: NextFunction) {
  const { userId } = (req as any).user
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { telegramVerified: true },
    })
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    if (!user.telegramVerified) {
      res.status(403).json({ error: 'TELEGRAM_NOT_VERIFIED' })
      return
    }
    next()
  } catch (err) {
    console.error('[auth] requireTelegramVerified failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
}
