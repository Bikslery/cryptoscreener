import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('persisted chart settings', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('migrates the legacy transparent hollow mode to normal candles', async () => {
    localStorage.setItem('sc.chart.settings.v1', JSON.stringify({ candlesType: 'hollow' }))

    const { useChartSettings } = await import('../chart-settings')

    expect(useChartSettings.getState().candlesType).toBe('default')
  })
})
