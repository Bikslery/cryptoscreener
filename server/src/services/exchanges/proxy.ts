import { HttpsProxyAgent as HttpsProxyAgentCtor } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { ProxyAgent } from 'undici'

const PROXY_URL = process.env.BINANCE_PROXY || ''

type AnyWsAgent = HttpsProxyAgentCtor<string> | SocksProxyAgent
let _wsAgent: AnyWsAgent | undefined
let _fetchDispatcher: ProxyAgent | undefined
let _initialized = false

function isSocks(url: string): boolean {
  return url.startsWith('socks4://') || url.startsWith('socks5://')
}

function init() {
  if (_initialized) return
  _initialized = true
  if (!PROXY_URL) return

  if (isSocks(PROXY_URL)) {
    _wsAgent = new SocksProxyAgent(PROXY_URL)
    console.log(`[Proxy] SOCKS5 proxy: ${PROXY_URL.replace(/:([^@]+)@/, ':****@')}`)
  } else {
    _wsAgent = new HttpsProxyAgentCtor(PROXY_URL)
    console.log(`[Proxy] HTTP proxy: ${PROXY_URL.replace(/:([^@]+)@/, ':****@')}`)
  }

  _fetchDispatcher = new ProxyAgent(PROXY_URL)
}

export function getWsAgent(): AnyWsAgent | undefined {
  init()
  return _wsAgent
}

export function getFetchDispatcher(): ProxyAgent | undefined {
  init()
  return _fetchDispatcher
}

export function getProxyUrl(): string | undefined {
  return PROXY_URL || undefined
}
