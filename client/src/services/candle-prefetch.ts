import api from './api'
import * as candleCache from './candle-cache'
import type { UnifiedCandle } from '../types'

const PREFETCH_LIMIT = 2000
const inflight = new Set<string>()

export function prefetchHistory(symbol: string, tf: string): void {
  const k = `${symbol}:${tf}`
  if (inflight.has(k)) return
  const cached = candleCache.getCandles(symbol, tf)
  if (cached && cached.length >= PREFETCH_LIMIT) return
  inflight.add(k)
  api.get(`/coins/${symbol}/candles`, { params: { tf, limit: PREFETCH_LIMIT } })
    .then(res => {
      const data = res.data as UnifiedCandle[]
      if (data?.length) candleCache.setCandles(symbol, tf, data)
    })
    .catch(() => {})
    .finally(() => inflight.delete(k))
}
