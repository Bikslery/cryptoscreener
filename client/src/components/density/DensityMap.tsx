import { memo, useMemo, useRef, useState, useCallback } from 'react'
import { useDensityStore } from '../../store/density'
import { useCoinListStore, useAuthStore } from '../../store'
import type { DensityWall, DensitySymbolBrp, UnifiedTicker } from '../../types'
import {
  toDensityCell,
  autoBrpMap,
  resolveDensitySettings,
  formatUsdt,
  formatAge,
  EXCHANGE_BADGE,
  EXCHANGE_COLOR,
} from '../../services/density'
import { extractBaseAsset } from '../../utils/format'

const CATEGORY_COLOR: Record<'small' | 'medium' | 'large', string> = {
  small: '#8a8a8a',
  medium: '#f0b90b',
  large: '#e74c3c',
}

const CATEGORY_LABEL: Record<'small' | 'medium' | 'large', string> = {
  small: 'малая',
  medium: 'средняя',
  large: 'большая',
}

interface WallBlock {
  wall: DensityWall
  category: 'small' | 'medium' | 'large'
  distancePct: number
  sizeUsdt: number
  bornAt: number
}

function useWallData() {
  const walls = useDensityStore(s => s.walls)
  const autoBrps = useDensityStore(s => s.autoBrps)
  const settingsPatch = useAuthStore(s => s.settings?.density)
  const coinMap = useCoinListStore(s => s.coinMap)
  return { walls, autoBrps, settingsPatch, coinMap }
}

function buildCells(
  walls: DensityWall[],
  autoBrps: DensitySymbolBrp[],
  settingsPatch: Parameters<typeof resolveDensitySettings>[0],
  coinMap: Map<string, UnifiedTicker>,
  symbol: string | null,
): WallBlock[] {
  if (!symbol) return []
  const settings = resolveDensitySettings(settingsPatch)
  const brps = autoBrpMap({ ts: 0, walls, autoBrps })
  const coin = coinMap.get(symbol)
  const price = coin?.price ?? 0
  const precision = coin?.pricePrecision ?? 2
  const out: WallBlock[] = []
  for (const wall of walls) {
    if (wall.symbol !== symbol) continue
    const cell = toDensityCell(wall, settings, brps.get(`${wall.exchange}:${wall.symbol}`) ?? null, price, precision)
    out.push({
      wall,
      category: cell.category,
      distancePct: cell.distancePct,
      sizeUsdt: wall.sizeUsdt,
      bornAt: wall.bornAt,
    })
  }
  return out
}

function WallBadge({ wall }: { wall: DensityWall }) {
  return (
    <span
      className="shrink-0 text-[9px] font-bold px-[3px] py-[1px] rounded-[2px] border"
      style={{ color: EXCHANGE_COLOR[wall.exchange], borderColor: `${EXCHANGE_COLOR[wall.exchange]}55`, background: `${EXCHANGE_COLOR[wall.exchange]}14` }}
    >
      {EXCHANGE_BADGE[wall.exchange]}
    </span>
  )
}

/** Vertical orderbook ladder: center = spread/mid, asks above, bids below,
 *  block position = distancePct within the zoom window. */
const Ladder = memo(function Ladder({
  cells,
  zoomPct,
  symbol,
  onWheelZoom,
  onClickWall,
}: {
  cells: WallBlock[]
  zoomPct: number
  symbol: string | null
  onWheelZoom: (delta: number) => void
  onClickWall: (symbol: string, price: number) => void
}) {
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.shiftKey) return
    e.preventDefault()
    onWheelZoom(e.deltaY)
  }, [onWheelZoom])

  const maxSize = useMemo(() => cells.reduce((m, c) => Math.max(m, c.sizeUsdt), 1), [cells])

  return (
    <div
      className="relative flex-1 min-h-0 overflow-hidden border-b border-[#1f1f1f]"
      onWheel={onWheel}
      data-testid="density-ladder"
    >
      {/* mid line */}
      <div className="absolute left-0 right-0 top-1/2 h-px bg-[#444] pointer-events-none" />
      <div className="absolute left-0 top-1/2 -translate-y-1/2 text-[9px] text-[#666] px-1 bg-[#0a0a0a] pointer-events-none select-none">
        {symbol ? `${zoomPct}%` : ''}
      </div>

      {cells.map((c, i) => {
        const d = c.distancePct
        if (Math.abs(d) > zoomPct) return null
        // asks (d > 0) above the mid line, bids below; position maps
        // [-zoom, +zoom] -> [100%, 0%] of the container height.
        const topPct = 50 - (d / zoomPct) * 50
        const widthPct = 18 + Math.min(62, (c.sizeUsdt / maxSize) * 62)
        const color = CATEGORY_COLOR[c.category]
        return (
          <button
            key={`${c.wall.exchange}:${c.wall.side}:${c.wall.price}:${i}`}
            className="absolute left-0 right-0 flex items-center gap-[4px] h-[18px] px-[4px] cursor-pointer hover:brightness-150 transition-[filter] text-left"
            style={{
              top: `${topPct}%`,
              transform: 'translateY(-50%)',
              background: `linear-gradient(90deg, ${color}33 ${widthPct}%, transparent ${widthPct}%)`,
              borderLeft: `2px solid ${color}`,
            }}
            title={`${c.wall.symbol} ${c.wall.side === 'bid' ? 'BID' : 'ASK'} @ ${c.wall.price} — ${formatUsdt(c.sizeUsdt)} (${CATEGORY_LABEL[c.category]})`}
            onClick={() => onClickWall(c.wall.symbol, c.wall.price)}
          >
            <span className="shrink-0 text-[10px] font-mono text-[#ccc]">{c.wall.price}</span>
            <WallBadge wall={c.wall} />
            <span className="text-[10px] text-[#ddd]">{formatUsdt(c.sizeUsdt)}</span>
            {c.wall.roundNumber && (
              <span className="w-[5px] h-[5px] rounded-full shrink-0" style={{ background: '#fff' }} title="круглое число" />
            )}
            <span className="ml-auto text-[9px] text-[#777]">{formatAge(c.bornAt)}</span>
          </button>
        )
      })}
    </div>
  )
})

export const DensityMap = memo(function DensityMap() {
  const { walls, autoBrps, settingsPatch, coinMap } = useWallData()
  const selectedSymbol = useCoinListStore(s => s.selectedSymbol)
  const sortedCoins = useCoinListStore(s => s.sortedCoins)
  const expandChartAtPrice = useCoinListStore(s => s.expandChartAtPrice)
  const updateSettings = useAuthStore(s => s.updateSettings)
  const settings = useAuthStore(s => s.settings)
  const [localZoom, setLocalZoom] = useState<number | null>(null)
  const zoomSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resolved = useMemo(() => resolveDensitySettings(settingsPatch), [settingsPatch])
  const zoomPct = localZoom ?? resolved.zoomPct

  const onWheelZoom = useCallback((deltaY: number) => {
    setLocalZoom(z => {
      const base = z ?? resolved.zoomPct
      const next = Math.min(10, Math.max(1, base + (deltaY > 0 ? -0.5 : 0.5)))
      if (zoomSaveTimer.current) clearTimeout(zoomSaveTimer.current)
      zoomSaveTimer.current = setTimeout(() => {
        updateSettings({ density: { ...(settings?.density ?? {}), zoomPct: next } }).catch(() => {})
      }, 600)
      return next
    })
  }, [resolved.zoomPct, updateSettings, settings?.density])

  const onClickWall = useCallback((symbol: string, price: number) => {
    expandChartAtPrice(symbol, price)
  }, [expandChartAtPrice])

  const symbol = selectedSymbol ?? (sortedCoins[0]?.symbol ?? null)
  const cells = useMemo(
    () => buildCells(walls, autoBrps, settingsPatch, coinMap, symbol),
    [walls, autoBrps, settingsPatch, coinMap, symbol],
  )

  // Global top walls list — "плотность и монета, на которой она стоит".
  const globalTop = useMemo(() => {
    const sorted = [...walls].sort((a, b) => b.sizeUsdt - a.sizeUsdt)
    return sorted.slice(0, 60)
  }, [walls])

  return (
    <div className="w-full h-full flex flex-col bg-[#0a0a0a]">
      <div className="flex items-center justify-between px-3 h-[30px] border-b border-[#1f1f1f] bg-[#0e0e0e] flex-shrink-0 select-none">
        <span className="text-[10px] font-medium text-[#888]">
          Стакан · {symbol ? extractBaseAsset(symbol) : '—'}
        </span>
        <span className="text-[9px] text-[#555]">Shift+колесо — зум {zoomPct}%</span>
      </div>

      {cells.length === 0 && (
        <div className="px-3 py-2 text-[10px] text-[#555] border-b border-[#1f1f1f]">
          Плотностей нет — выберите монету или подождите снапшот (2с)
        </div>
      )}

      <Ladder cells={cells} zoomPct={zoomPct} symbol={symbol} onWheelZoom={onWheelZoom} onClickWall={onClickWall} />

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-[6px] text-[10px] font-medium text-[#888] border-b border-[#1f1f1f] bg-[#0e0e0e] flex-shrink-0">
          Все плотности
        </div>
        <div className="flex-1 overflow-y-auto">
          {globalTop.length === 0 && (
            <div className="px-3 py-2 text-[10px] text-[#555]">Нет данных — сервер собирает стаканы…</div>
          )}
          {globalTop.map((w, i) => {
            const color = EXCHANGE_COLOR[w.exchange]
            return (
              <button
                key={`${w.exchange}:${w.symbol}:${w.side}:${w.price}:${i}`}
                className="w-full flex items-center gap-[5px] px-3 py-[4px] text-left hover:bg-white/[0.03] cursor-pointer border-b border-[#141414]"
                onClick={() => onClickWall(w.symbol, w.price)}
              >
                <span className="shrink-0 w-[8px] text-[10px] font-mono text-[#888]">{i + 1}</span>
                <span className="shrink-0 text-[11px] font-medium text-[#e5e5e5]">{extractBaseAsset(w.symbol)}</span>
                <WallBadge wall={w} />
                <span className="text-[10px] text-[#888]">{w.side === 'bid' ? 'BID' : 'ASK'}</span>
                <span className="text-[10px] font-mono text-[#aaa]">{w.price}</span>
                <span className="ml-auto text-[10px]" style={{ color }}>{formatUsdt(w.sizeUsdt)}</span>
                <span className="text-[9px] text-[#666] w-[34px] text-right">{formatAge(w.bornAt)}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
})
