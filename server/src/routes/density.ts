import { Router } from 'express'
import { getDensitySnapshot } from '../services/density/index.js'

const router = Router()

// Latest density snapshot — the client's startup payload; WS keeps it fresh
// afterwards. ?limit= caps the number of walls (top by sizeUsdt), default 500.
router.get('/', (req, res) => {
  const limitRaw = parseInt(String(req.query.limit ?? '500'), 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 2000)) : 500
  res.json(getDensitySnapshot(limit))
})

export default router
