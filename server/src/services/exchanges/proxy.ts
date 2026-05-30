import { HttpsProxyAgent as HttpsProxyAgentCtor } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { ProxyAgent } from 'undici'
import type { Agent } from 'http'

const PROXY_URLS = (process.env.BINANCE_PROXY || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

type AnyWsAgent = HttpsProxyAgentCtor<string> | SocksProxyAgent

interface PoolEntry {
  url: string
  wsAgent: AnyWsAgent | undefined
  fetchDispatcher: ProxyAgent | undefined
  currentWeight: number
}

const pool: PoolEntry[] = []
let _initialized = false

function isSocks(url: string): boolean {
  return url.startsWith('socks4://') || url.startsWith('socks5://')
}

function init() {
  if (_initialized) return
  _initialized = true

  if (PROXY_URLS.length === 0) {
    pool.push({ url: '', wsAgent: undefined, fetchDispatcher: undefined, currentWeight: 0 })
    return
  }

  for (const url of PROXY_URLS) {
    let wsAgent: AnyWsAgent | undefined
    let fetchDispatcher: ProxyAgent | undefined

    if (isSocks(url)) {
      wsAgent = new SocksProxyAgent(url)
    } else {
      wsAgent = new HttpsProxyAgentCtor(url)
    }

    fetchDispatcher = new ProxyAgent(url)

    pool.push({ url, wsAgent, fetchDispatcher, currentWeight: 0 })
    console.log(`[Proxy] Configured: ${url.replace(/:([^@]+)@/, ':****@')}`)
  }
}

export function getWsAgent(ipIndex?: number): AnyWsAgent | undefined {
  init()
  const idx = ipIndex ?? 0
  return pool[Math.min(idx, pool.length - 1)]?.wsAgent
}

export function getFetchDispatcher(ipIndex?: number): ProxyAgent | undefined {
  init()
  const idx = ipIndex ?? 0
  return pool[Math.min(idx, pool.length - 1)]?.fetchDispatcher
}

export function pickDispatcher(): { dispatcher: ProxyAgent | undefined; ipIndex: number } {
  init()
  let bestIdx = 0
  let bestWeight = Infinity
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].currentWeight < bestWeight) {
      bestWeight = pool[i].currentWeight
      bestIdx = i
    }
  }
  return { dispatcher: pool[bestIdx].fetchDispatcher, ipIndex: bestIdx }
}

export function addWeightToIp(ipIndex: number, weight: number): void {
  init()
  if (ipIndex >= 0 && ipIndex < pool.length) {
    pool[ipIndex].currentWeight += weight
  }
}

export function getIpCount(): number {
  init()
  return pool.length
}

export function getProxyUrl(): string | undefined {
  return PROXY_URLS[0] || undefined
}
