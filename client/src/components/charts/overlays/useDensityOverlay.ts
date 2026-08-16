import { useEffect, useRef } from 'react'
import type { ISeriesApi, SeriesType } from 'lightweight-charts'
import { useDensityStore } from '../../../store/density'
import { useAuthStore } from '../../../store'
import { useChartSettings } from '../../../services/chart-settings'
import {
  autoBrpMap,
  resolveDensitySettings,
  formatUsdt,
  formatAge,
  EXCHANGE_BADGE,
} from '../../../services/density'
import { calcTier } from '../../../services/density-cluster'
import { DensityPrimitive, type DensityLineSpec } from './DensityPrimitive'
import type { Exchange } from '../../../types'

/** density color scheme (scalpboard): bid green, ask red */
const DENSITY_DOWN = '#43c743'
const DENSITY_UP = '#c74343'

/**
 * Attaches the density (orderbook walls) primitive to the expanded chart.
 * Walls come from the global density snapshot, filtered by symbol AND the
 * chart's exchange (a wall's price belongs to that venue's book); a wall is
 * drawn only when it reaches at least the Small tier, which requires it to
 * have lived past the tier's minimum lifetime.
 */
export function useDensityOverlay(
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  chartVersion: number,
  symbol: string,
  pricePrecision: number,
  exchange: Exchange | undefined,
): void {
  const primitiveRef = useRef<DensityPrimitive | null>(null)
  const walls = useDensityStore(s => s.walls)
  const autoBrps = useDensityStore(s => s.autoBrps)
  const settingsPatch = useAuthStore(s => s.settings?.density)
  const showDensities = useChartSettings(s => s.showDensities)

  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    const prim = new DensityPrimitive()
    series.attachPrimitive(prim)
    primitiveRef.current = prim
    return () => {
      // MUST detach: a primitive left attached to a disposed chart throws
      // "Object is disposed" from the chart's resize/render loop and breaks
      // the whole pane's painting.
      try {
        series.detachPrimitive(prim)
      } catch { /* already disposed */ }
      primitiveRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartVersion])

  useEffect(() => {
    const prim = primitiveRef.current
    if (!prim) return
    if (!showDensities) {
      prim.update(null, pricePrecision)
      return
    }
    const settings = resolveDensitySettings(settingsPatch)
    const brps = autoBrpMap({ ts: 0, walls, autoBrps })
    const now = Date.now()
    const specs: DensityLineSpec[] = []
    for (const wall of walls) {
      if (wall.symbol !== symbol) continue
      if (exchange && wall.exchange !== exchange) continue
      if (wall.bornAt - now > 60_000) continue
      const tier = calcTier(wall, settings, brps.get(`${wall.exchange}:${wall.symbol}`) ?? null, now)
      if (tier === undefined) continue
      specs.push({
        price: wall.price,
        birthTimeSec: Math.floor(wall.bornAt / 1000),
        color: wall.side === 'bid' ? DENSITY_DOWN : DENSITY_UP,
        text: `${EXCHANGE_BADGE[wall.exchange]} ${formatUsdt(wall.sizeUsdt)} ${wall.price.toFixed(pricePrecision)} ${formatAge(wall.bornAt, now)}`,
        baseline: wall.side === 'ask' ? 'bottom' : 'top',
      })
    }
    prim.update(specs, pricePrecision)
  }, [walls, autoBrps, settingsPatch, showDensities, symbol, pricePrecision, exchange, chartVersion])
}
