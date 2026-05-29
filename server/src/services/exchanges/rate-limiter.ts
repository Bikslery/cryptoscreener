const WEIGHT_WARNING_THRESHOLD = 0.8

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
    if (ratio >= WEIGHT_WARNING_THRESHOLD && Date.now() - this.lastWarning > 30_000) {
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

  isThrottled(): boolean {
    return Date.now() < this.throttledUntil || Date.now() < this.backoffUntil
  }

  async waitIfThrottled(): Promise<void> {
    while (this.isThrottled()) {
      const waitUntil = Math.max(this.throttledUntil, this.backoffUntil)
      const delay = Math.max(waitUntil - Date.now(), 100)
      console.warn(`[RateLimit:${this.market}] Throttled, waiting ${Math.ceil(delay / 1000)}s...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }

  getWeight(): number {
    return this.currentWeight
  }

  getLimit(): number {
    return this.limit
  }
}
