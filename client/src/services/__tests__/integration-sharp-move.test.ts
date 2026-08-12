import { describe, it, expect, beforeAll } from 'vitest'
import { createCandleLifecycle, type TradePayload } from '../candle-lifecycle'
import { applyCandleUpdates } from '../candle-merge'
import { validateCandle, normalizeCandle } from '../candle-utils'
import type { UnifiedCandle, Exchange } from '../../types'

/**
 * INTEGRATION: real server history + sharp-move replay.
 *
 * Pulls REAL 1m history from the deployed screener API (VPS), replays a
 * realistic sharp-move sequence (trades + klines, including a WS stream skip
 * with a REST backfill) through the exact same client pipeline that paints
 * the charts:
 *
 *   history ── applyHistory ──▶ lifecycle ── applyTrade/applyKline ──▶ patch
 *                     ▲                                                    │
 *                     └─────────────── applyCandleUpdates ◀────────────────┘
 *                                  (ChartGrid's backing-array merge)
 *
 * Guards: every candle OHLC-valid (no outliers), array sorted, no missing
 * time buckets in the replayed window (no holes).
 *
 * The server must be reachable; if the API is down the suite skips with a
 * warning instead of failing (unit coverage of the same logic lives in
 * candle-merge.test.ts / candle-lifecycle.test.ts).
 */

const EX: Exchange = 'binance-futures'
const SYM = 'BTCUSDT'
const TF = '1m'
const TF_SEC = 60
// Overridable for local testing, e.g. SCREENER_API_URL=http://localhost:3001.
// Accessed via globalThis (not `process`) — the client tsconfig has no node
// types, and `process` would fail the tsc -b build in Docker.
const envVars = (globalThis as { process?: { env?: Record<string, string> } }).process?.env
const API = envVars?.SCREENER_API_URL || 'http://31.76.244.65'

async function fetchHistory(
  symbol: string,
  tf: string,
  limit: number,
  exchange?: Exchange,
  before?: number,
): Promise<UnifiedCandle[]> {
  const params = new URLSearchParams({ tf, limit: String(limit), compact: '0' })
  if (exchange) params.set('exchange', exchange)
  if (before !== undefined) params.set('before', String(before))
  const res = await fetch(`${API}/api/coins/${symbol}/candles?${params}`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`history HTTP ${res.status} for ${symbol} ${tf}`)
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/** True when any adjacent pair skips a bucket. */
function hasHoles(candles: UnifiedCandle[], tfSec = TF_SEC): boolean {
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time - candles[i - 1].time !== tfSec) return true
  }
  return false
}

function sortedTimes(candles: UnifiedCandle[]): number[] {
  return candles.map(c => c.time).sort((a, b) => a - b)
}

// Probe the API at module scope (top-level await) so describe.skipIf can see it.
let serverUp = false
try {
  const res = await fetch(`${API}/api/coins/${SYM}/candles?tf=1m&limit=5&exchange=binance-futures`, {
    signal: AbortSignal.timeout(10000),
  })
  serverUp = res.ok
} catch {
  serverUp = false
}
if (!serverUp) {
  console.warn(`[integration-sharp-move] Screener API unreachable (${API}) — integration tests skipped`)
}

describe.skipIf(!serverUp)('Integration: real server history + sharp-move replay', () => {
  let history: UnifiedCandle[] = []

  beforeAll(async () => {
    history = await fetchHistory(SYM, TF, 200, EX)
  }, 30000)

  it('replays a sharp move over real history — no holes, no outliers', { timeout: 30000 }, async () => {
    expect(history.length).toBeGreaterThan(20)

    // ChartGrid.renderCandles equivalent: valid + normalized backing array.
    const base = history.filter(validateCandle).map(normalizeCandle)
    const arr = [...base]

    const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
    lc.applyHistory(base)

    const last = arr[arr.length - 1]
    const moveTime = last.time + TF_SEC
    const basePrice = last.close

    // Sharp up-move in the next period: 3 trades + a covering kline.
    const p1 = basePrice * 1.04
    const p2 = basePrice * 1.12
    const p3 = basePrice * 1.06

    const t1 = lc.applyTrade({ symbol: SYM, exchange: EX, price: p1, qty: 3, time: moveTime + 2 } as TradePayload)
    expect(t1.candleUpdates[0].open).toBe(p1)
    // Newer than the tail → incremental update path (no full repaint needed).
    expect(applyCandleUpdates(arr, t1.candleUpdates)).toBe(false)

    const t2 = lc.applyTrade({ symbol: SYM, exchange: EX, price: p2, qty: 5, time: moveTime + 30 } as TradePayload)
    expect(applyCandleUpdates(arr, t2.candleUpdates)).toBe(false)

    lc.applyTrade({ symbol: SYM, exchange: EX, price: p3, qty: 4, time: moveTime + 50 } as TradePayload)

    // Non-final kline covering the period (trades are newer → merge keeps the
    // real kline open while high/low envelope everything).
    const kline: UnifiedCandle = {
      symbol: SYM, exchange: EX, timeframe: TF, time: moveTime,
      open: basePrice, high: p2 * 1.001, low: p1 * 0.999, close: p3, volume: 1200,
      source: 'kline', isFinal: false,
    }
    const kp = lc.applyKline(kline)
    applyCandleUpdates(arr, kp.candleUpdates)

    // The sharp-move candle exists with the expected shape.
    const sharp = arr.find(c => c.time === moveTime)
    expect(sharp).toBeDefined()
    expect(sharp!.open).toBe(basePrice)
    expect(sharp!.close).toBe(p3)
    expect(sharp!.high).toBeGreaterThanOrEqual(Math.max(p1, p2, p3, kline.high))
    expect(sharp!.low).toBeLessThanOrEqual(Math.min(p1, p2, p3, kline.low))

    // No outliers: every candle passes the OHLC guard used by the render path.
    expect(arr.every(validateCandle)).toBe(true)
    // Sorted.
    expect(arr.map(c => c.time)).toEqual(sortedTimes(arr))
    // No holes across the whole replay (real history tail → sharp candle).
    expect(hasHoles(arr.slice(-5))).toBe(false)
  })

  it('backfills a real WS gap with real REST candles — no holes remain', { timeout: 30000 }, async () => {
    expect(history.length).toBeGreaterThan(20)
    const base = history.filter(validateCandle).map(normalizeCandle)

    // Simulate a WS stream that skipped the last 3 periods during a sharp
    // move: the client tracked up to len-4, then a kline for the current
    // period arrives.
    const tailLen = base.length - 3
    expect(tailLen).toBeGreaterThan(5)
    const tail = base.slice(0, tailLen)
    const arriving = base[base.length - 1]
    const gapStart = tail[tail.length - 1].time + TF_SEC
    const gapEnd = arriving.time - TF_SEC
    const bucketCount = Math.round((gapEnd - gapStart) / TF_SEC) + 1
    expect(bucketCount).toBeGreaterThan(0)

    const lc = createCandleLifecycle({ symbol: SYM, exchange: EX, tf: TF, tfSeconds: TF_SEC })
    lc.applyHistory(tail)
    const arr = [...tail]

    const patch = lc.applyKline({ ...arriving, isFinal: false })
    expect(patch.gapBackfill).toEqual({ fromTime: gapStart, toTime: gapEnd })

    // 1) ChartGrid paints the arriving kline IMMEDIATELY (useWsCandle), so
    //    the forming candle becomes the array's last bar.
    expect(applyCandleUpdates(arr, patch.candleUpdates)).toBe(false)

    // 2) THEN the async backfill lands — exactly what backfillGap does in
    //    ChartGrid: REST fetch → applyOlderPage → applyChartPatch.
    const fetched = await fetchHistory(SYM, TF, 10, EX, arriving.time + TF_SEC)
    const inWindow = fetched.filter(c => c.time >= gapStart && c.time <= gapEnd)
    const expectedTimes: number[] = []
    for (let t = gapStart; t <= gapEnd; t += TF_SEC) expectedTimes.push(t)
    expect(inWindow.map(c => c.time).sort((a, b) => a - b)).toEqual(expectedTimes)

    const fill = lc.applyOlderPage(inWindow)
    // The gap candles are now OLDER than the forming candle → ChartGrid's
    // decision is the full setData repaint path (previously this silently
    // threw in LWC and the hole stayed open forever).
    expect(applyCandleUpdates(arr, fill.candleUpdates)).toBe(true)

    // Final array: hole-free from the gap onward, no outliers anywhere.
    expect(hasHoles(arr.filter(c => c.time >= gapStart))).toBe(false)
    expect(arr.every(validateCandle)).toBe(true)
    expect(arr.map(c => c.time)).toEqual(sortedTimes(arr))
  })
})
