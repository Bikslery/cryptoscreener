import { useEffect, useRef } from 'react'
import type { ISeriesApi, SeriesType } from 'lightweight-charts'
import type { UnifiedCandle } from '../../../types'
import { computeOverlays } from '../../../services/chart-overlays'
import { useAuthStore } from '../../../store'
import { OverlaysPrimitive } from './OverlaysPrimitive'

/**
 * Attaches the scalpboard-parity overlays primitive (cascades + density) to
 * the chart's candle series and keeps it in sync with the data.
 *
 * The primitive is (re)attached whenever the chart is recreated
 * (`chartVersion` bumps in the chart-creation effect), and the overlay data
 * is recomputed on every data tick and when the user's cascade config
 * changes (cabinet settings, server-persisted).
 */
export function useChartOverlays(
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  candlesDataRef: React.RefObject<UnifiedCandle[]>,
  dataVersion: number,
  chartVersion: number,
  pricePrecision: number,
): void {
  const primitiveRef = useRef<OverlaysPrimitive | null>(null)

  const cascadesConfig = useAuthStore(s => s.settings?.cascades)

  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    const prim = new OverlaysPrimitive()
    series.attachPrimitive(prim)
    primitiveRef.current = prim
    return () => {
      primitiveRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartVersion])

  useEffect(() => {
    const prim = primitiveRef.current
    const candles = candlesDataRef.current
    if (!prim) return
    const cfg = { ...cascadesConfig }
    if (cfg.showCascades === false && cfg.showDensities === false) {
      prim.update(null, null, pricePrecision)
      return
    }
    const data = computeOverlays(candles ?? [], pricePrecision, cascadesConfig)
    prim.update(data, candles && candles.length > 0 ? candles[candles.length - 1].time : null, pricePrecision)
  }, [dataVersion, cascadesConfig, pricePrecision, chartVersion, candlesDataRef])
}