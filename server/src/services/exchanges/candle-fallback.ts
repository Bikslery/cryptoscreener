import type { UnifiedCandle } from '../../types.js'

/**
 * Shared WS-silence → REST-poll fallback for kline streams (the guard
 * binance-futures had inline; spot and Bybit previously froze their forming
 * tails with no recovery until the socket healed).
 *
 * Semantics match the futures implementation:
 *  - a checker notices when NO kline frame arrived for `silenceTimeoutMs`;
 *  - a bounded round-robin poller then REST-fetches the latest 2 candles per
 *    subscribed stream and re-emits them through the normal callback paths;
 *  - any real WS message resets the clock and stops the poller.
 */
const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
}

export interface CandleSilenceFallbackOpts {
  name: string
  /** Resolve the latest candles for one stream (limit is always 2). */
  fetch: (symbol: string, tf: string) => Promise<UnifiedCandle[]>
  /** Deliver a polled candle through the adapter's normal fan-out. */
  emit: (candle: UnifiedCandle) => void
  /** Extra gate (adapter rate limiter) checked before each tick. */
  skip?: () => boolean
  maxPerTick?: number
  silenceTimeoutMs?: number
  pollIntervalMs?: number
}

export class CandleSilenceFallback {
  private readonly opts: Required<Omit<CandleSilenceFallbackOpts, 'skip'>> & Pick<CandleSilenceFallbackOpts, 'skip'>
  private subs = new Map<string, { symbol: string; tf: string }>()
  private lastMsgAt = Date.now()
  private checkerTimer: ReturnType<typeof setInterval> | null = null
  private pollerTimer: ReturnType<typeof setInterval> | null = null
  private active = false
  private cursor = 0

  constructor(opts: CandleSilenceFallbackOpts) {
    this.opts = {
      maxPerTick: 20,
      silenceTimeoutMs: 10_000,
      pollIntervalMs: 1_500,
      ...opts,
    }
  }

  register(key: string, symbol: string, tf: string): void {
    this.subs.set(key, { symbol, tf })
    this.lastMsgAt = Date.now()
    this.startChecker()
  }

  unregister(key: string): void {
    this.subs.delete(key)
  }

  noteMessage(): void {
    this.lastMsgAt = Date.now()
    if (this.active) this.stopFallback()
  }

  stop(): void {
    if (this.checkerTimer) { clearInterval(this.checkerTimer); this.checkerTimer = null }
    this.stopFallback()
  }

  get activeFallback(): boolean {
    return this.active
  }

  private startChecker(): void {
    if (this.checkerTimer) return
    this.checkerTimer = setInterval(() => {
      if (this.subs.size === 0 || this.active) return
      if (Date.now() - this.lastMsgAt > this.opts.silenceTimeoutMs) {
        console.warn(`[${this.opts.name}] Candle WS silent for ${this.opts.silenceTimeoutMs / 1000}s → REST-poll fallback`)
        this.startFallback()
      }
    }, 2_000)
  }

  private startFallback(): void {
    if (this.active) return
    this.active = true
    this.pollOnce()
    this.pollerTimer = setInterval(() => this.pollOnce(), this.opts.pollIntervalMs)
  }

  private stopFallback(): void {
    this.active = false
    if (this.pollerTimer) { clearInterval(this.pollerTimer); this.pollerTimer = null }
  }

  private async pollOnce(): Promise<void> {
    if (this.opts.skip?.()) return
    const entries = Array.from(this.subs.entries())
    if (entries.length === 0) { this.stopFallback(); return }

    // Bounded round-robin window so polling every subscribed stream in
    // parallel cannot burn the exchange weight budget in one tick.
    const window: [string, { symbol: string; tf: string }][] = []
    const n = entries.length
    for (let i = 0; i < this.opts.maxPerTick && window.length < n; i++) {
      window.push(entries[this.cursor % n])
      this.cursor++
    }

    const nowSec = Date.now() / 1000
    await Promise.allSettled(window.map(async ([, { symbol, tf }]) => {
      try {
        const candles = await this.opts.fetch(symbol, tf)
        const tfSec = TF_SECONDS[tf] || 60
        for (const c of candles) {
          this.opts.emit({ ...c, isFinal: c.time + tfSec <= nowSec })
        }
      } catch {
        // transient failure — the next tick retries
      }
    }))
  }
}
