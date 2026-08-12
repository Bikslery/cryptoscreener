import { normalizeCandle, isFiniteOHLCV } from './candle-utils'
import { sanitizeCandle, contextWindow } from './candle-sanity'
import type { UnifiedCandle } from '../types'

/**
 * Merge candle updates into the full backing array with a sorted upsert.
 *
 * Older candles (delayed klines, gap-backfill after a WS stream skip during
 * sharp action) are INSERTED in order — previously they were silently dropped
 * here, so the chart kept a permanent hole and even a later repaint never saw
 * them.
 *
 * Returns `true` when the update is out-of-order (any candle older than the
 * array's last bar). lightweight-charts' `series.update()` THROWS for any bar
 * whose time is older than the series' last bar ("Cannot update oldest data"),
 * so callers must paint such patches via a full `setData()` repaint instead of
 * the incremental update() path.
 */
export function applyCandleUpdates(arr: UnifiedCandle[], updates: UnifiedCandle[]): boolean {
  if (updates.length === 0) return false
  const last = arr[arr.length - 1]
  const lastTime = last ? last.time : null

  // Track only the candles that actually land in the array: invalid OHLC must
  // never become a phantom bar (it would skew logical indexes on prepends and
  // linger in the backing array even though the incremental paint path skips it).
  //
  // Sanity gate: every candle that ENTERS the array passes through the
  // phantom-candle detector. A clear outlier (absurd range/price vs its local
  // neighbours) is clamped into the neighbours' band instead of being painted
  // as a giant fake candle — the log record keeps the original for diagnosis.
  const applied: UnifiedCandle[] = []
  for (const raw of updates) {
    const c = normalizeCandle(raw)
    if (!isFiniteOHLCV(c) || !(c.time > 0)) continue
    const tail = arr[arr.length - 1]
    let safe: UnifiedCandle
    if (tail && tail.time === c.time) {
      safe = sanitizeCandle(c, contextWindow(arr, arr.length - 1), 'array-update')
    } else if (!tail || c.time > tail.time) {
      safe = sanitizeCandle(c, contextWindow(arr, -1), 'array-update')
    } else {
      const idx = arr.findIndex(x => x.time >= c.time)
      safe = sanitizeCandle(c, contextWindow(arr, Math.max(0, idx)), 'array-update')
    }
    applied.push(safe)
    if (tail && tail.time === safe.time) {
      arr[arr.length - 1] = safe
    } else if (!tail || safe.time > tail.time) {
      arr.push(safe)
    } else {
      const idx = arr.findIndex(x => x.time >= safe.time)
      if (idx >= 0 && arr[idx].time === safe.time) arr[idx] = safe
      else arr.splice(idx, 0, safe)
    }
  }

  return lastTime != null && applied.some(c => c.time < lastTime)
}
