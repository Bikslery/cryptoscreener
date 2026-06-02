import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production'
const COOKIE_NAME = 'token'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 days in ms
const REFRESH_THRESHOLD = 24 * 60 * 60 * 1000 // refresh if < 1 day left

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

export function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
