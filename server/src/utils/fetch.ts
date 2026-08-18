import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'

// One shared keep-alive connection pool for ALL exchange REST traffic.
// Undici's default global dispatcher keeps sockets alive for only ~4s —
// every metrics pass (30s), correlation pass (5m) and stats poll (60s) paid
// a fresh TCP+TLS handshake (~50-150ms each). With 60s keep-alive the
// sockets to fapi/api.binance.com stay warm between passes, and preload
// (hundreds of requests) reuses them instead of handshaking per request.
const keepAliveAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connections: 64,
  pipelining: 1,
})

export function getKeepAliveDispatcher(): Agent {
  return keepAliveAgent
}

/**
 * Fetch with abort-on-timeout over npm undici (keep-alive by default,
 * ProxyAgent when supplied).
 *
 * CRITICAL: this MUST call undici's own `fetch`, never the Node-global one.
 * Node's built-in fetch bundles a different undici major whose
 * Dispatcher→handler protocol is incompatible with npm undici 8 dispatchers
 * — passing our Agent there throws `fetch failed: invalid onRequestStart
 * method` on EVERY request, which zeroed all metrics and killed candle
 * history. Same-package fetch + Agent is the only consistent combination.
 */
export async function fetchWithTimeout(
  url: string,
  ms = 10000,
  dispatcher?: ProxyAgent | Agent,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await undiciFetch(url, {
      signal: ctrl.signal,
      dispatcher: dispatcher ?? keepAliveAgent,
    })
    return res as unknown as Response
  } finally {
    clearTimeout(timer)
  }
}
