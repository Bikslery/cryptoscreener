import type { IndicatorKey, CoinListColKey, UserSettings } from '../types'
import { formatCompact } from '../utils/format'

export const DEFAULT_COIN_LIST: readonly CoinListColKey[] = ['symbol', 'change24h', 'range1m', 'natr5m', 'quoteVolume24h']
export const DEFAULT_CHART_HEADER: readonly IndicatorKey[] = ['change24h', 'natr5m', 'range1m', 'quoteVolume24h']

export const VALID_INDICATOR_KEYS: readonly IndicatorKey[] = ['change24h', 'range1m', 'natr5m', 'quoteVolume24h', 'corrBtc', 'tradesSpike', 'volumeSpike']

export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  change24h: 'CHG 24h',
  range1m: 'Range 1m',
  natr5m: 'NATR 5m',
  quoteVolume24h: 'Vol 24h',
  corrBtc: 'Corr BTC',
  tradesSpike: 'Trades ×5m',
  volumeSpike: 'Vol ×5m',
}

export interface ColumnMeta {
  key: CoinListColKey
  header: string
  subheader: string
  width: string
}

export const COLUMN_META: Record<CoinListColKey, { header: string; subheader: string; width: string }> = {
  symbol: { header: 'TICKER', subheader: '', width: '1.1fr' },
  change24h: { header: 'CHG', subheader: '24h', width: '1fr' },
  range1m: { header: 'RANGE', subheader: '1m/5', width: '1fr' },
  natr5m: { header: 'NATR', subheader: '5m/14', width: '1fr' },
  quoteVolume24h: { header: 'VOL', subheader: '24h', width: '1.1fr' },
  corrBtc: { header: 'CORR', subheader: 'BTC·5h', width: '1fr' },
  tradesSpike: { header: 'TRADES', subheader: '×5m', width: '1fr' },
  volumeSpike: { header: 'V-SPK', subheader: '×5m', width: '1fr' },
}

export interface ResolvedIndicators {
  coinList: CoinListColKey[]
  chartHeader: IndicatorKey[]
}

/**
 * Resolve the user's indicator configuration into ordered, deduplicated,
 * validated column lists. `symbol` is always pinned first in the coin list;
 * an empty result falls back to defaults (settings may contain garbage from
 * older clients or hand-edited DB rows).
 */
export function resolveIndicators(raw?: UserSettings['indicators'] | null): ResolvedIndicators {

  const coinList: CoinListColKey[] = ['symbol']
  for (const k of raw?.coinList ?? DEFAULT_COIN_LIST) {
    if (k === 'symbol' || !VALID_INDICATOR_KEYS.includes(k as IndicatorKey) || coinList.includes(k)) continue
    coinList.push(k)
  }
  if (coinList.length === 1) coinList.push(...DEFAULT_COIN_LIST.slice(1))

  const chartHeader: IndicatorKey[] = []
  for (const k of raw?.chartHeader ?? DEFAULT_CHART_HEADER) {
    if (!VALID_INDICATOR_KEYS.includes(k) || chartHeader.includes(k)) continue
    chartHeader.push(k)
  }
  if (chartHeader.length === 0) chartHeader.push(...DEFAULT_CHART_HEADER)

  return { coinList, chartHeader }
}

/** Format an indicator cell value (null spikes/corr render as '-'). */
export function formatIndicator(key: IndicatorKey, v: number | string | null | undefined): string {
  if (key === 'change24h') {
    const n = v as number
    return `${n >= 0 ? '+' : ''}${n.toFixed(1)}`
  }
  if (key === 'range1m' || key === 'natr5m') return v ? (v as number).toFixed(1) : '-'
  if (key === 'quoteVolume24h') return formatCompact(v as number)
  if (key === 'corrBtc') return v === null || v === undefined ? '-' : (v as number).toFixed(2)
  return v === null || v === undefined ? '-' : `${(v as number).toFixed(1)}×`
}
