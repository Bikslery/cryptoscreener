import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const ROLE = process.env.ROLE || 'all'
export const REDIS_ENABLED = ROLE === 'ingestion' || ROLE === 'broadcast'

let _pub: Redis | null = null
let _sub: Redis | null = null
let _data: Redis | null = null

function createClient(): Redis {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 10) return null
      return Math.min(times * 500, 5000)
    },
    lazyConnect: true,
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
    _sub.subscribe('tickers', 'candles', 'depth', 'trades', 'alerts').catch(() => {})
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
