import { describe, it, expect } from 'vitest'
import {
  resolveIndicators,
  formatIndicator,
  DEFAULT_COIN_LIST,
  DEFAULT_CHART_HEADER,
} from '../indicators'
import type { CoinListColKey, IndicatorKey } from '../../types'

function cfg(coinList: unknown[], chartHeader: unknown[]) {
  return { coinList: coinList as CoinListColKey[], chartHeader: chartHeader as IndicatorKey[] }
}

describe('resolveIndicators', () => {
  it('returns defaults when settings are missing', () => {
    expect(resolveIndicators(undefined)).toEqual({
      coinList: [...DEFAULT_COIN_LIST],
      chartHeader: [...DEFAULT_CHART_HEADER],
    })
    expect(resolveIndicators(null)).toEqual({
      coinList: [...DEFAULT_COIN_LIST],
      chartHeader: [...DEFAULT_CHART_HEADER],
    })
  })

  it('pins symbol first and keeps the configured order after it', () => {
    const res = resolveIndicators(cfg(['corrBtc', 'change24h', 'symbol', 'natr5m'], ['volumeSpike', 'corrBtc']))
    expect(res.coinList).toEqual(['symbol', 'corrBtc', 'change24h', 'natr5m'])
    expect(res.chartHeader).toEqual(['volumeSpike', 'corrBtc'])
  })

  it('drops unknown and duplicate keys', () => {
    const res = resolveIndicators(cfg(['symbol', 'hax', 'corrBtc', 'corrBtc', 'natr5m'], ['change24h', 'change24h', 'bogus']))
    expect(res.coinList).toEqual(['symbol', 'corrBtc', 'natr5m'])
    expect(res.chartHeader).toEqual(['change24h'])
  })

  it('falls back to defaults when everything is filtered out', () => {
    const res = resolveIndicators(cfg(['junk', 'garbage'], []))
    expect(res.coinList).toEqual([...DEFAULT_COIN_LIST])
    expect(res.chartHeader).toEqual([...DEFAULT_CHART_HEADER])
  })

  it('tolerates missing fields from hand-edited settings', () => {
    const res = resolveIndicators({ coinList: undefined as never, chartHeader: undefined as never })
    expect(res.coinList).toEqual([...DEFAULT_COIN_LIST])
    expect(res.chartHeader).toEqual([...DEFAULT_CHART_HEADER])
  })
})

describe('formatIndicator', () => {
  it('formats change24h with a sign', () => {
    expect(formatIndicator('change24h', 1.234)).toBe('+1.2')
    expect(formatIndicator('change24h', -0.567)).toBe('-0.6')
  })

  it('formats range1m/natr5m with one decimal and dash for falsy', () => {
    expect(formatIndicator('natr5m', 0.42)).toBe('0.4')
    expect(formatIndicator('range1m', 0)).toBe('-')
  })

  it('formats corrBtc with two decimals and dash for null', () => {
    expect(formatIndicator('corrBtc', 0.9555)).toBe('0.96')
    expect(formatIndicator('corrBtc', null)).toBe('-')
    expect(formatIndicator('corrBtc', undefined)).toBe('-')
  })

  it('formats spikes with × suffix and dash for null', () => {
    expect(formatIndicator('tradesSpike', 2.55)).toBe('2.5×')
    expect(formatIndicator('volumeSpike', 1.04)).toBe('1.0×')
    expect(formatIndicator('tradesSpike', null)).toBe('-')
  })

  it('formats quoteVolume24h compact', () => {
    expect(formatIndicator('quoteVolume24h', 1_234_567)).toBe('1.2M')
  })
})
