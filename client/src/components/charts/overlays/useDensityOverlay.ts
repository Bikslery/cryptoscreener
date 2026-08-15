import { useEffect, useRef } from 'react'
import type { ISeriesApi, SeriesType } from 'lightweight-charts'
import { useDensityStore } from '../../../store/density'
import { useAuthStore, useCoinListStore } from '../../../store'
import { useChartSettings } from '../../../services/chart-settings'
import {
  toDensityCell,
  autoBrpMap,
  resolveDensitySettings,
  formatUsdt,
  formatAge,
  EXCHANGE_BADGE,
} from '../../../services/density'
import { DensityPrimitive, type DensityLineSpec } from './DensityPrimitive'

const CATEGORY_COLOR: Record<'small' | 'medium' | 'large', string> = {
  small: '#8a8a8a',
  medium: '#f0b90b',
  large: '#e74c3c',
}

/**
 * Attaches the density (orderbook walls) primitive to the expanded chart.
 * Walls come from the global density snapshot, filtered by symbol; category
 * and threshold are the user's personal settings (server-persisted).
 */
export function useDensityOverlay(
  candleRef: React.RefObject<ISeriesApi<SeriesType> | null>,
  chartVersion: number,
  symbol: string,
  pricePrecision: number,
): void {
  const primitiveRef = useRef<DensityPrimitive | null>(null)
  const walls = useDensityStore(s => s.walls)
  const autoBrps = useDensityStore(s => s.autoBrps)
  const settingsPatch = useAuthStore(s => s.settings?.density)
  const showDensities = useChartSettings(s => s.showDensities)
  const coinMap = useCoinListStore(s => s.coinMap)

  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    const prim = new DensityPrimitive()
    series.attachPrimitive(prim)
    primitiveRef.current = prim
    return () => {
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
    const price = coinMap.get(symbol)?.price ?? 0
    const specs: DensityLineSpec[] = []
    for (const wall of walls) {
      if (wall.symbol !== symbol) continue
      const cell = toDensityCell(wall, settings, brps.get(`${wall.exchange}:${wall.symbol}`) ?? null, price, pricePrecision)
      specs.push({
        price: wall.price,
        color: CATEGORY_COLOR[cell.category],
        text: `${EXCHANGE_BADGE[wall.exchange]} ${formatUsdt(wall.sizeUsdt)} ${formatAge(wall.bornAt)}`,
        baseline: wall.side === 'ask' ? 'bottom' : 'top',
      })
    }
    prim.update(specs, pricePrecision)
  }, [walls, autoBrps, settingsPatch, showDensities, symbol, pricePrecision, chartVersion, coinMap])
}
