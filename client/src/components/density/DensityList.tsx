import { memo, useEffect, useState } from 'react'
import { useDensityStore } from '../../store/density'
import { useCoinListStore, useAuthStore } from '../../store'
import type { DensityWall, DensitySymbolBrp } from '../../types'
import type { Tier } from '../../services/density-cluster'
import {
  autoBrpMap,
  resolveDensitySettings,
  formatUsdt,
  formatAge,
  EXCHANGE_BADGE,
  EXCHANGE_COLOR,
} from '../../services/density'
import { calcTier } from '../../services/density-cluster'
import { extractBaseAsset } from '../../utils/format'

interface ListRow {
  wall: DensityWall
  tier: Tier
  distancePct: number
}

const TIER_LABEL: Record<Tier, string> = { 1: 'Большие', 2: 'Средние', 3: 'Малые' }

function priceText(price: number, precision: number | undefined): string {
  if (precision !== undefined && precision >= 0 && precision <= 8) return price.toFixed(precision)
  if (price >= 1000) return price.toFixed(1)
  if (price >= 1) return price.toFixed(2)
  if (price >= 0.01) return price.toFixed(4)
  return price.toFixed(6)
}

function buildRows(
  walls: DensityWall[],
  autoBrps: DensitySymbolBrp[],
  symbol: string,
  currentPrice: number,
  settingsPatch: Parameters<typeof resolveDensitySettings>[0],
  now: number,
): { asks: ListRow[]; bids: ListRow[] } {
  const settings = resolveDensitySettings(settingsPatch)
  const brps = autoBrpMap({ ts: 0, walls, autoBrps })
  const asks: ListRow[] = []
  const bids: ListRow[] = []
  for (const wall of walls) {
    if (wall.symbol !== symbol) continue
    if (wall.bornAt - now > 60_000) continue
    const tier = calcTier(wall, settings, brps.get(`${wall.exchange}:${wall.symbol}`) ?? null, now)
    if (tier === undefined) continue
    const row: ListRow = {
      wall,
      tier,
      distancePct: currentPrice > 0 ? ((wall.price - currentPrice) / currentPrice) * 100 : 0,
    }
    ;(wall.side === 'ask' ? asks : bids).push(row)
  }
  // Ближайшие к цене сверху.
  const byDistance = (a: ListRow, b: ListRow) => Math.abs(a.distancePct) - Math.abs(b.distancePct)
  asks.sort(byDistance)
  bids.sort(byDistance)
  return { asks, bids }
}

function Row({ row, precision, onClick }: { row: ListRow; precision: number | undefined; onClick: () => void }) {
  const { wall, tier, distancePct } = row
  const isAsk = wall.side === 'ask'
  const sideColor = isAsk ? '#c74343' : '#43c743'
  return (
    <button
      className="w-full flex items-center gap-[6px] px-2 py-[3px] text-left cursor-pointer hover:bg-[#161616] border-l-2"
      style={{ borderColor: sideColor }}
      title={`${isAsk ? 'Продажа (ask)' : 'Покупка (bid)'} · ${TIER_LABEL[tier]} · прожила ${formatAge(wall.bornAt)}`}
      onClick={onClick}
    >
      <span
        className="shrink-0 text-[8px] font-semibold px-[3px] py-[1px] rounded-[2px]"
        style={{ color: EXCHANGE_COLOR[wall.exchange], background: 'rgba(255,255,255,0.05)' }}
      >
        {EXCHANGE_BADGE[wall.exchange]}
      </span>
      <span className="shrink-0 text-[11px] font-semibold text-white/90 tabular-nums">
        {formatUsdt(wall.sizeUsdt)}
      </span>
      <span className="shrink-0 text-[10px] text-[#bbb] tabular-nums">
        {priceText(wall.price, precision)}
      </span>
      <span className="ml-auto flex items-baseline gap-[6px] shrink-0">
        <span className="text-[9px] text-[#777] tabular-nums">{formatAge(wall.bornAt)}</span>
        <span
          className="text-[9px] font-medium tabular-nums w-[44px] text-right"
          style={{ color: sideColor }}
        >
          {distancePct >= 0 ? '+' : ''}{distancePct.toFixed(2)}%
        </span>
      </span>
    </button>
  )
}

/**
 * Список всех плотностей текущей монеты (scalpboard-стиль): аски сверху,
 * биды снизу, внутри — по расстоянию от цены. Строка: биржа, размер, цена,
 * возраст (длительность с момента рождения), расстояние. Клик центрирует
 * график на цене стены.
 */
export const DensityList = memo(function DensityList() {
  const walls = useDensityStore(s => s.walls)
  const autoBrps = useDensityStore(s => s.autoBrps)
  const settingsPatch = useAuthStore(s => s.settings?.density)
  const symbol = useCoinListStore(s => s.expandedSymbol ?? s.selectedSymbol)
  const coinMap = useCoinListStore(s => s.coinMap)
  const expandChartAtPrice = useCoinListStore(s => s.expandChartAtPrice)
  // Возраст и тир тикают каждую секунду, не дожидаясь снапшота (раз в 2 с).
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const coin = symbol !== null ? coinMap.get(symbol) : undefined
  const currentPrice = coin?.price ?? 0
  const precision = coin?.pricePrecision

  if (symbol === null) {
    return (
      <div className="h-full flex items-center justify-center text-[11px] text-[#555] px-6 text-center">
        Выберите монету, чтобы увидеть её плотности
      </div>
    )
  }

  const { asks, bids } = buildRows(walls, autoBrps, symbol, currentPrice, settingsPatch, now)

  return (
    <div className="h-full overflow-y-auto" data-testid="density-list">
      <div className="px-3 py-[6px] text-[10px] text-[#777] sticky top-0 bg-[#0e0e0e] border-b border-[#1f1f1f] z-[5]">
        {extractBaseAsset(symbol)} · {currentPrice > 0 ? priceText(currentPrice, precision) : '—'}
        <span className="float-right">плотностей: {asks.length + bids.length}</span>
      </div>

      {asks.length === 0 && bids.length === 0 && (
        <div className="px-4 py-6 text-[10px] text-[#555] text-center leading-relaxed">
          Нет плотностей для {extractBaseAsset(symbol)}
          <br />
          <span className="text-[#444]">
            стена попадает в список после ≥ {resolveDensitySettings(settingsPatch).lifeSmall} мин жизни
          </span>
        </div>
      )}

      {asks.length > 0 && (
        <div className="px-2 pt-[6px] pb-[2px] text-[9px] font-semibold tracking-wide text-[#c74343]">
          ПРОДАЖА (аски)
        </div>
      )}
      {asks.map(row => (
        <Row
          key={`${row.wall.exchange}:${row.wall.side}:${row.wall.price}`}
          row={row}
          precision={precision}
          onClick={() => expandChartAtPrice(symbol, row.wall.price)}
        />
      ))}

      {bids.length > 0 && (
        <div className="px-2 pt-[8px] pb-[2px] text-[9px] font-semibold tracking-wide text-[#43c743]">
          ПОКУПКА (биды)
        </div>
      )}
      {bids.map(row => (
        <Row
          key={`${row.wall.exchange}:${row.wall.side}:${row.wall.price}`}
          row={row}
          precision={precision}
          onClick={() => expandChartAtPrice(symbol, row.wall.price)}
        />
      ))}
    </div>
  )
})
