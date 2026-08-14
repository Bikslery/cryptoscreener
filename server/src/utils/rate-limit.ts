import rateLimit from 'express-rate-limit'

// Shared limiter for user-data write endpoints (alerts / watchlists /
// drawings). Auth and market-data endpoints define their own budgets.
// The drawings client saves with a debounce after drag-end, so its budget
// is deliberately wider than alerts/watchlists.
export function writeRateLimit(max: number, windowMs = 60_000) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  })
}
