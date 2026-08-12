import { normalizeCandle, isFiniteOHLCV } from './candle-utils'
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
  const applied: UnifiedCandle[] = []
  for (const raw of updates) {
    const c = normalizeCandle(raw)
    if (!isFiniteOHLCV(c) || !(c.time > 0)) continue
    applied.push(c)
    const tail = arr[arr.length - 1]
    if (tail && tail.time === c.time) {
      arr[arr.length - 1] = c
    } else if (!tail || c.time > tail.time) {
      arr.push(c)
    } else {
      const idx = arr.findIndex(x => x.time >= c.time)
      if (idx >= 0 && arr[idx].time === c.time) arr[idx] = c
      else arr.splice(idx, 0, c)
    }
  }

  return lastTime != null && applied.some(c => c.time < lastTime)
}
