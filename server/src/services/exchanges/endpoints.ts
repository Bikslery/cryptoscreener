/**
 * Single source of truth for Binance WebSocket base URLs.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The futures WS base used to be resolved independently in two places
 * (binance-futures.ts and trades/aggTrade.ts) from the SAME env var
 * `BINANCE_FUTURES_WS_BASE`, but with DIFFERENT hardcoded defaults:
 *
 *   binance-futures.ts → wss://fstream.binance.com        (ticker/kline/depth)
 *   trades/aggTrade.ts → wss://fstream.binancefuture.com  (aggTrade)
 *
 * `fstream.binance.com` is geo-blocked from some regions (verified: EU/German
 * datacenter IPs) — the socket opens, then closes without ever delivering a
 * frame. So on a blocked host the aggTrade lane worked (correct domain) while
 * ticker/kline/depth silently fell back to REST polling: the futures ticker
 * to a 1s price poll, and candles to a bounded round-robin REST poll
 * (MAX_FALLBACK_PER_TICK streams per 1.5s tick). With ~100 subscribed streams
 * that is multi-second candle staleness while the trade lane stays realtime —
 * exactly the "chart lags behind the стакан" symptom.
 *
 * Both lanes now resolve through here, so they cannot diverge again.
 */

/** Verified reachable from regions where `fstream.binance.com` is blocked. */
const FUTURES_WS_DEFAULT = 'wss://fstream.binancefuture.com'
const SPOT_WS_DEFAULT = 'wss://stream.binance.com:9443'

function clean(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return undefined
  // A trailing slash would produce `//stream` / `//ws` paths downstream.
  return trimmed.replace(/\/+$/, '')
}

/**
 * Futures market-data streams (ticker, kline, depth).
 * Override with `BINANCE_FUTURES_WS_BASE`.
 */
export const FUTURES_WS_BASE = clean(process.env.BINANCE_FUTURES_WS_BASE) ?? FUTURES_WS_DEFAULT

/**
 * Futures aggTrade streams. Defaults to the same host as the market-data
 * streams; `BINANCE_FUTURES_AGGTRADE_WS_BASE` exists only so the two lanes can
 * be split deliberately (e.g. routing one through a different proxy while
 * diagnosing a regional block) rather than by accident.
 */
export const FUTURES_AGGTRADE_WS_BASE =
  clean(process.env.BINANCE_FUTURES_AGGTRADE_WS_BASE) ?? FUTURES_WS_BASE

/** Spot streams (ticker, kline, depth, aggTrade). Override with `BINANCE_SPOT_WS_BASE`. */
export const SPOT_WS_BASE = clean(process.env.BINANCE_SPOT_WS_BASE) ?? SPOT_WS_DEFAULT

/** Logged once at boot so the ACTIVE domains are visible without grepping env. */
export function logWsEndpoints(): void {
  const overridden = (envKey: string) => (process.env[envKey]?.trim() ? ' (env override)' : '')
  console.log(
    `[Endpoints] Binance WS bases → futures=${FUTURES_WS_BASE}${overridden('BINANCE_FUTURES_WS_BASE')} ` +
    `futuresAggTrade=${FUTURES_AGGTRADE_WS_BASE}${overridden('BINANCE_FUTURES_AGGTRADE_WS_BASE')} ` +
    `spot=${SPOT_WS_BASE}${overridden('BINANCE_SPOT_WS_BASE')}`,
  )
}
