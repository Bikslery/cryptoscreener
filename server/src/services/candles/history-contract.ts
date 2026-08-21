import type { Exchange, UnifiedCandle } from '../../types.js'

export type HistoryStatus = 'complete' | 'partial' | 'no_data'

export interface HistoryMeta {
  status: HistoryStatus
  complete: boolean
  noData: boolean
  nextBefore: number | null
  source: Exchange | null
  marketType: 'spot' | 'futures' | null
  cached: boolean
  degraded: boolean
  generatedAt: number
  freshnessMs: number | null
}

export interface BuildHistoryMetaOptions {
  requestedLimit: number
  cached: boolean
  source?: Exchange | null
  degraded?: boolean
  generatedAt?: number
}

export function buildHistoryMeta(candles: UnifiedCandle[], options: BuildHistoryMetaOptions): HistoryMeta {
  const source = candles[0]?.exchange ?? options.source ?? null
  const complete = candles.length >= options.requestedLimit
  const noData = candles.length === 0
  const last = candles[candles.length - 1]
  const generatedAt = options.generatedAt ?? Date.now()
  return {
    status: noData ? 'no_data' : complete ? 'complete' : 'partial',
    complete,
    noData,
    nextBefore: candles[0]?.time ?? null,
    source,
    marketType: source ? (source.includes('futures') ? 'futures' : 'spot') : null,
    cached: options.cached,
    degraded: options.degraded ?? false,
    generatedAt,
    freshnessMs: last ? Math.max(0, generatedAt - last.time * 1000) : null,
  }
}
