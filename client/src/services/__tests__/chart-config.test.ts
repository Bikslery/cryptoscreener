import { describe, expect, it } from 'vitest'
import { candleSeriesOptions } from '../chart-config'
import { DEFAULT_CHART_SETTINGS, type ChartSettings } from '../chart-settings'

function settings(candlesType: ChartSettings['candlesType']): ChartSettings {
  return { ...DEFAULT_CHART_SETTINGS, candlesType }
}

describe('candleSeriesOptions', () => {
  it.each(['default', 'hollow'] as const)(
    'keeps candle bodies opaque in %s mode',
    (candlesType) => {
      const options = candleSeriesOptions(settings(candlesType)) as {
        upColor?: string
        downColor?: string
      }

      expect(options.upColor).toMatch(/^#[0-9a-f]{6}$/i)
      expect(options.downColor).toMatch(/^#[0-9a-f]{6}$/i)
    },
  )
})
