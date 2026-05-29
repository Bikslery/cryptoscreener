const WEIGHT_THRESHOLD_RATIO = 0.8
const CIRCUIT_BREAKER_ERRORS = 5
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000
const BAN_COOLDOWN_MS = 120_000

const LIMITS: Record<string, number> = {
  spot: 6000,
  futures: 2400,
}

const WEIGHT_HEADERS = [
  'X-Mbx-Used-Weight-1m',
  'X-Mbx-Used-Weight',
]

const WEIGHT_HEADERS_FUTURES = [
  'X-Mbx-Futures-Used-Weight-1m',
  'X-Mbx-Used-Weight-1m',
  'X-Mbx-Used-Weight',
]

const RETRY_AFTER_HEADER = 'Retry-After'

export class BinanceRateLimiter {
  private market: 'spot' | 'futures'
  private limit: number
  private currentWeight = 0
  private throttledUntil = 0
  private backoffUntil = 0
  private lastWarning = 0
  private consecutiveErrors = 0
  private circuitBrokenUntil = 0

  constructor(market: 'spot' | 'futures') {
    this.market = market
    this.limit = LIMITS[market]
  }

  updateFromHeaders(headers: Headers) {
    const headerKeys = this.market === 'futures' ? WEIGHT_HEADERS_FUTURES : WEIGHT_HEADERS
    for (const key of headerKeys) {
      const val = headers.get(key)
      if (val) {
        const weight = parseInt(val, 10)
        if (!isNaN(weight)) {
          this.currentWeight = weight
          break
        }
      }
    }

    const ratio = this.currentWeight / this.limit
    if (ratio >= WEIGHT_THRESHOLD_RATIO && Date.now() - this.lastWarning > 30_000) {
      this.lastWarning = Date.now()
      console.warn(`[RateLimit:${this.market}] Weight at ${this.currentWeight}/${this.limit} (${(ratio * 100).toFixed(1)}%)`)
    }
  }

  handle429(headers: Headers) {
    const retryAfter = headers.get(RETRY_AFTER_HEADER)
    let waitMs = 60_000
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10)
      if (!isNaN(parsed)) waitMs = parsed * 1000
    }
    this.throttledUntil = Date.now() + waitMs
    this.currentWeight = 0
    console.error(`[RateLimit:${this.market}] 429 hit! Throttling for ${waitMs / 1000}s`)
  }

  handle418(headers: Headers) {
    const retryAfter = headers.get(RETRY_AFTER_HEADER)
    let waitMs = BAN_COOLDOWN_MS
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10)
      if (!isNaN(parsed) && parsed * 1000 > waitMs) waitMs = parsed * 1000
    }
    this.throttledUntil = Date.now() + waitMs
    this.currentWeight = 0
    console.error(`[RateLimit:${this.market}] 418 IP ban! Throttling for ${waitMs / 1000}s`)
  }

  isOverThreshold(): boolean {
    return this.currentWeight >= this.limit * WEIGHT_THRESHOLD_RATIO
  }

  isThrottled(): boolean {
    const now = Date.now()
    return now < this.throttledUntil || now < this.backoffUntil || now < this.circuitBrokenUntil
  }

  async waitIfThrottled(): Promise<void> {
    while (this.isThrottled()) {
      const waitUntil = Math.max(this.throttledUntil, this.backoffUntil, this.circuitBrokenUntil)
      const delay = Math.max(waitUntil - Date.now(), 100)
      console.warn(`[RateLimit:${this.market}] Throttled, waiting ${Math.ceil(delay / 1000)}s...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }

  recordError() {
    this.consecutiveErrors++
    if (this.consecutiveErrors >= CIRCUIT_BREAKER_ERRORS) {
      this.circuitBrokenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS
      console.error(`[RateLimit:${this.market}] Circuit breaker triggered! ${this.consecutiveErrors} consecutive errors, pausing for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`)
    }
  }

  recordSuccess() {
    this.consecutiveErrors = 0
  }

  getWeight(): number {
    return this.currentWeight
  }

  getLimit(): number {
    return this.limit
  }
}
