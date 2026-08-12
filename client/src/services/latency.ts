// WS frame latency tracking (server stamps `ts` on ticker/price frames).
// The client records arrival latency and logs p50/p95 every 30s so we can
// see where the pipeline actually spends its milliseconds instead of guessing.
const MAX_SAMPLES = 4000
const LOG_INTERVAL_MS = 30_000

const samples: number[] = []
let lastLogAt = 0
let total = 0

export function recordFrameLatency(ms: number) {
  if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return
  samples.push(ms)
  total++
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)

  const now = Date.now()
  if (now - lastLogAt < LOG_INTERVAL_MS) return
  lastLogAt = now

  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0
  console.info(`[Latency] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms n=${total}`)
}

/** Snapshot of the current distribution (useful for debugging / future UI). */
export function getLatencyStats() {
  if (samples.length === 0) return { count: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    count: samples.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
  }
}
