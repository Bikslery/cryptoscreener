import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const ROLE = process.env.ROLE || 'all'
export const REDIS_ENABLED = ROLE === 'ingestion' || ROLE === 'broadcast' || ROLE === 'all'

let _pub: Redis | null = null
let _sub: Redis | null = null
let _data: Redis | null = null

function createClient(): Redis {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    // NEVER stop reconnecting: a transient ~30s Redis outage used to end
    // reconnection attempts forever (returning null from this strategy
    // disables them for the process lifetime), silently blinding broadcast
    // nodes' market data until a manual restart. Backoff caps at 5s instead.
    retryStrategy(times) {
      return Math.min(500 + times * 250, 5000)
    },
    lazyConnect: true,
    // A hung Redis (swap/pressure) must never park candle-history requests:
    // commands abort after 2s and the caller falls back to cache/exchange.
    commandTimeout: 2000,
    connectTimeout: 5000,
  })
  client.on('error', (err) => {
    if (REDIS_ENABLED) console.warn('[Redis] Connection error:', err.message)
  })
  return client
}

export function getRedisPub(): Redis {
  if (!_pub) _pub = createClient()
  return _pub
}

export function getRedisSub(): Redis {
  if (!_sub) {
    _sub = createClient()
    _sub.subscribe('tickers', 'candles', 'depth', 'trades', 'alerts', 'sub-req', 'price').catch(() => {})
  }
  return _sub
}

export function getRedisData(): Redis {
  if (!_data) _data = createClient()
  return _data
}

export async function disconnectRedis() {
  const promises: Promise<string>[] = []
  if (_pub) { promises.push(_pub.quit()); _pub = null }
  if (_sub) { promises.push(_sub.quit()); _sub = null }
  if (_data) { promises.push(_data.quit()); _data = null }
  await Promise.allSettled(promises)
}
