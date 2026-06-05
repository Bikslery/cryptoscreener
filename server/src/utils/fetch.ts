import type { ProxyAgent } from 'undici'

/**
 * Fetch with abort-on-timeout. Supports optional undici ProxyAgent dispatcher
 * for proxied requests (Binance adapters).
 */
export async function fetchWithTimeout(
  url: string,
  ms = 10000,
  dispatcher?: ProxyAgent,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const opts: RequestInit & { dispatcher?: ProxyAgent } = { signal: ctrl.signal }
    if (dispatcher) opts.dispatcher = dispatcher
    const res = await fetch(url, opts as RequestInit)
    return res
  } finally {
    clearTimeout(timer)
  }
}
