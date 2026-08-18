/**
 * REST depth snapshots (Binance `<symbol>@depth` seeding) share the exchange
 * REST budget with candle history. Without a concurrency cap, subscribing
 * TOP_N symbols fires N parallel snapshots before ANY response header
 * refreshes the limiter's weight gauge — a burst that blows the 2400/min
 * weight window and starves chart history (the exact failure the density
 * feature caused on launch). This module serializes snapshot fetches so
 * responses land between batches and the header-driven limiter gates the
 * next batch before it can overshoot.
 */
const MAX_CONCURRENT_SNAPSHOTS = 4

let active = 0
const waiters: Array<() => void> = []

function release(): void {
  const next = waiters.shift()
  if (next) next()
  else active--
}

export async function withDepthSnapshotSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT_SNAPSHOTS) {
    active++
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  try {
    return await fn()
  } finally {
    release()
  }
}
