import { memo, useMemo, useRef, useState, useCallback } from 'react'
import { useDensityStore } from '../../store/density'
import { useCoinListStore, useAuthStore } from '../../store'
import type { DensityWall, DensitySymbolBrp, UnifiedTicker } from '../../types'
import {
  autoBrpMap,
  resolveDensitySettings,
  formatUsdt,
  EXCHANGE_BADGE,
} from '../../services/density'
import { clusterDensities, type DensityItem, type Tier } from '../../services/density-cluster'
import { hueIndexFor, claimHue, wallColor } from '../../utils/claimHue'
import { extractBaseAsset } from '../../utils/format'

const TIER_COUNT = 3

/** Строка карты: одна стена/плотность с позицией по тиру и расстоянию. */
interface MapBlock {
  item: DensityItem
  symbol: string
  exchange: DensityWall['exchange']
  side: 'bid' | 'ask'
  price: number
  count: number
  sumUsdt: number
  distancePct: number
  tier: Tier
  hue: number
  lOffset: number
}

function buildBlocks(
  walls: DensityWall[],
  autoBrps: DensitySymbolBrp[],
  settingsPatch: Parameters<typeof resolveDensitySettings>[0],
  coinMap: Map<string, UnifiedTicker>,
): MapBlock[] {
  const settings = resolveDensitySettings(settingsPatch)
  const brps = autoBrpMap({ ts: 0, walls, autoBrps })
  const hidden = new Set(settings.hiddenSymbols)
  const items = clusterDensities(walls, settings, brps)
  const tierVisible = (t: Tier) =>
    (t === 1 && settings.showLarge) || (t === 2 && settings.showMedium) || (t === 3 && settings.showSmall)

  const out: MapBlock[] = []
  for (const item of items) {
    if (!tierVisible(item.tier)) continue
    const { symbol, exchange, side, price } = item.wall
    if (hidden.has(symbol)) continue
    const currentPrice = coinMap.get(symbol)?.price ?? 0
    if (currentPrice <= 0) continue
    const distancePct = ((price - currentPrice) / currentPrice) * 100
    const sumUsdt = item.members.reduce((s, m) => s + m.sizeUsdt, 0)
    const idx = hueIndexFor(symbol)
    const { hue, lOffset } = claimHue(idx)
    out.push({
      item,
      symbol,
      exchange,
      side,
      price,
      count: item.members.length,
      sumUsdt,
      distancePct,
      tier: item.tier,
      hue,
      lOffset,
    })
  }
  return out
}

const TIER_LABEL: Record<Tier, string> = {
  1: 'Большие',
  2: 'Средние',
  3: 'Малые',
}

/**
 * Двумерная карта плотностей (scalpboard AppMapDensity): верхняя зона —
 * аски, нижняя — биды, между ними линия текущей цены; по горизонтали 3
 * колонки-тира (Большие/Средние/Малые), по вертикали — расстояние от цены
 * в процентах внутри окна «глубины». Цвет блока — hue монеты.
 */
export const DensityMap = memo(function DensityMap() {
  const walls = useDensityStore(s => s.walls)
  const autoBrps = useDensityStore(s => s.autoBrps)
  const settingsPatch = useAuthStore(s => s.settings?.density)
  const coinMap = useCoinListStore(s => s.coinMap)
  const expandChartAtPrice = useCoinListStore(s => s.expandChartAtPrice)
  const updateSettings = useAuthStore(s => s.updateSettings)
  const settings = useAuthStore(s => s.settings)
  const [localZoom, setLocalZoom] = useState<number | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const zoomSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resolved = useMemo(() => resolveDensitySettings(settingsPatch), [settingsPatch])
  const zoomPct = localZoom ?? resolved.zoomPct

  const onWheelZoom = useCallback((deltaY: number) => {
    setLocalZoom(z => {
      const base = z ?? resolved.zoomPct
      const next = Math.min(10, Math.max(0.5, base + (deltaY > 0 ? -0.5 : 0.5)))
      if (zoomSaveTimer.current) clearTimeout(zoomSaveTimer.current)
      zoomSaveTimer.current = setTimeout(() => {
        updateSettings({ density: { ...(settings?.density ?? {}), zoomPct: next } }).catch(() => {})
      }, 600)
      return next
    })
  }, [resolved.zoomPct, updateSettings, settings?.density])

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.shiftKey) return
    e.preventDefault()
    onWheelZoom(e.deltaY)
  }, [onWheelZoom])

  const onClickBlock = useCallback((symbol: string, price: number) => {
    expandChartAtPrice(symbol, price)
  }, [expandChartAtPrice])

  const blocks = useMemo(
    () => buildBlocks(walls, autoBrps, settingsPatch, coinMap),
    [walls, autoBrps, settingsPatch, coinMap],
  )

  return (
    <div className="w-full h-full flex flex-col bg-[#0a0a0a]">
      <div className="flex items-center justify-between px-3 h-[30px] border-b border-[#1f1f1f] bg-[#0e0e0e] flex-shrink-0 select-none">
        <span className="text-[10px] font-medium text-[#888]">Плотности</span>
        <span className="text-[9px] text-[#555]">Shift+колесо — глубина {zoomPct.toFixed(1)}%</span>
      </div>

      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        onWheel={onWheel}
        data-testid="density-map"
      >
        {/* mid line (current price) */}
        <div className="absolute left-0 right-0 top-1/2 h-px bg-[#444] pointer-events-none z-10" />
        <div className="absolute left-0 top-1/2 -translate-y-1/2 text-[9px] text-[#666] px-1 bg-[#0a0a0a] pointer-events-none select-none z-10">
          {zoomPct.toFixed(1)}%
        </div>

        {/* tier column separators */}
        {[1, 2].map(i => (
          <div
            key={i}
            className="absolute top-0 bottom-0 w-px bg-[#141414] pointer-events-none"
            style={{ left: `${(100 / TIER_COUNT) * i}%` }}
          />
        ))}

        {blocks.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-[#555]">
            Плотностей нет — сервер собирает стаканы…
          </div>
        )}

        {blocks.map((b) => {
          const key = `${b.exchange}:${b.symbol}:${b.side}:${b.price}:${b.tier}`
          if (Math.abs(b.distancePct) > zoomPct) return null
          const colW = 100 / TIER_COUNT
          const left = colW * b.tier - colW / 2
          const yPct = Math.min(100, Math.max(0, Math.abs(b.distancePct) / zoomPct * 100))
          // ask zone: block bottom = 50% + yPct/2 of container; bid zone: same for top
          const zonePos = 50 + yPct / 2
          const color = wallColor(b.hue, b.lOffset)
          const focused = focusedKey === key
          return (
            <button
              key={key}
              className={`absolute flex flex-col items-start justify-center px-[3px] rounded-[2px] cursor-pointer border transition-[filter] text-left z-[5] ${
                focused ? 'brightness-150' : 'hover:brightness-150'
              }`}
              style={{
                left: `${left}%`,
                width: `${colW - 4}%`,
                height: '20px',
                transform: 'translateX(-50%) translateY(-50%)',
                bottom: b.side === 'ask' ? `${zonePos}%` : 'auto',
                top: b.side === 'bid' ? `${zonePos}%` : 'auto',
                background: color,
                borderColor: color.replace(/0\.9\)$/, '1)'),
              }}
              title={`${b.symbol} ${b.side === 'bid' ? 'BID' : 'ASK'} @ ${b.price} — ${formatUsdt(b.sumUsdt)} (${TIER_LABEL[b.tier]})`}
              onMouseEnter={() => setFocusedKey(key)}
              onMouseLeave={() => setFocusedKey(null)}
              onClick={() => onClickBlock(b.symbol, b.price)}
            >
              <span className="w-full flex items-baseline gap-[3px] leading-[9px]">
                <span className="truncate text-[9px] font-bold text-white/95">
                  {extractBaseAsset(b.symbol)}
                </span>
                {resolved.showMarket && (
                  <span className="text-[7px] text-white/70">{EXCHANGE_BADGE[b.exchange]}</span>
                )}
                <span className="ml-auto shrink-0 text-[8px] text-white/90">
                  {b.count > 1 ? `${b.count}·` : ''}{formatUsdt(b.sumUsdt)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* tier legend */}
      <div className="flex items-center h-[24px] border-t border-[#1f1f1f] bg-[#0e0e0e] flex-shrink-0 select-none">
        {([1, 2, 3] as Tier[]).map(t => (
          <div key={t} className="flex-1 text-center text-[9px] text-[#777]">
            {TIER_LABEL[t]}
          </div>
        ))}
      </div>
    </div>
  )
})
