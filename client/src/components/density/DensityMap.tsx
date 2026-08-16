import { memo, useMemo, useRef, useState, useCallback } from 'react'
import { useDensityStore } from '../../store/density'
import { useCoinListStore, useAuthStore } from '../../store'
import type { DensityWall, DensitySymbolBrp, UnifiedTicker } from '../../types'
import {
  autoBrpMap,
  resolveDensitySettings,
  formatUsdt,
  formatAge,
  EXCHANGE_BADGE,
} from '../../services/density'
import { clusterDensities, type DensityItem, type Tier } from '../../services/density-cluster'
import { hueIndexFor, claimHue, wallColor } from '../../utils/claimHue'
import { extractBaseAsset } from '../../utils/format'

const TIER_COUNT = 3
/** Вертикальный шаг слота (в % высоты зоны) — блоки одной колонки не накладываются. */
const SLOT_PCT = 8

/** Строка карты: одна стена/плотность с позицией по тиру и расстоянию. */
interface MapBlock {
  item: DensityItem
  symbol: string
  exchange: DensityWall['exchange']
  side: 'bid' | 'ask'
  price: number
  bornAt: number
  count: number
  sumUsdt: number
  distancePct: number
  tier: Tier
  roundNumber: boolean
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
      bornAt: Math.min(...item.members.map(m => m.bornAt)),
      count: item.members.length,
      sumUsdt,
      distancePct,
      tier: item.tier,
      roundNumber: item.members.some(m => m.roundNumber),
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
 * Двумерная карта плотностей — копия scalpboard AppMapDensity/AppMapWall:
 * центральная линия — спред; верхняя зона — аски, нижняя — биды; блок
 * позиционируется расстоянием от цены внутри своей зоны
 * (bottom/top = distance/depth×100%). По горизонтали 3 колонки-тира,
 * легенда-шапка grid-cols-3 uppercase 10px, фоновая сетка каждые 0.5%.
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

  const blocks = useMemo(
    () => buildBlocks(walls, autoBrps, settingsPatch, coinMap),
    [walls, autoBrps, settingsPatch, coinMap],
  )

  /** Жадная раскладка по слотам внутри каждой (side, tier)-колонки. */
  const slots = useMemo(() => {
    const slotOf = new Map<MapBlock, number>()
    const cols = new Map<string, MapBlock[]>()
    for (const b of blocks) {
      if (Math.abs(b.distancePct) > zoomPct) continue
      const ck = `${b.side}:${b.tier}`
      const arr = cols.get(ck)
      if (arr) arr.push(b)
      else cols.set(ck, [b])
    }
    for (const group of cols.values()) {
      group.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
      const used = new Set<number>()
      for (const b of group) {
        const yPct = Math.min(100, Math.max(0, (Math.abs(b.distancePct) / zoomPct) * 100))
        let slot = Math.round(yPct / SLOT_PCT) * SLOT_PCT
        while (used.has(slot) && slot < 100) slot += SLOT_PCT
        used.add(slot)
        slotOf.set(b, Math.min(slot, 100 - SLOT_PCT / 2))
      }
    }
    return slotOf
  }, [blocks, zoomPct])

  const colW = 100 / TIER_COUNT
  const gridlines = useMemo(() => {
    const n = Math.ceil(zoomPct / 0.5)
    return Array.from({ length: n - 1 }, (_, i) => (((i + 1) * 0.5) / zoomPct) * 100)
  }, [zoomPct])

  const renderBlock = (b: MapBlock) => {
    const slot = slots.get(b)
    if (slot === undefined) return null
    const key = `${b.exchange}:${b.symbol}:${b.side}:${b.price}:${b.tier}`
    const left = colW * b.tier - colW / 2
    const color = wallColor(b.hue, b.lOffset)
    const focused = focusedKey === key
    return (
      <button
        key={key}
        className={`absolute flex items-center gap-[3px] px-[5px] h-[20px] rounded-[3px] cursor-pointer border text-left ${
          focused ? 'brightness-150' : 'hover:brightness-125'
        }`}
        style={{
          zIndex: focused ? 200 : 99,
          left: `${left}%`,
          width: `${colW - 6}%`,
          // аски прижаты к линии сверху, биды — снизу, с отступом 2px
          ...(b.side === 'ask'
            ? { bottom: `${slot}%`, transform: 'translateX(-50%) translateY(calc(-100% - 2px))' }
            : { top: `${slot}%`, transform: 'translateX(-50%) translateY(2px)' }),
          backgroundColor: color,
        }}
        title={`${b.symbol} ${b.side === 'bid' ? 'BID' : 'ASK'} @ ${b.price} — ${formatUsdt(b.sumUsdt)} · ${formatAge(b.bornAt)}${b.roundNumber ? ' · круглое число' : ''}`}
        onMouseEnter={() => setFocusedKey(key)}
        onMouseLeave={() => setFocusedKey(null)}
        onClick={() => expandChartAtPrice(b.symbol, b.price)}
      >
        <span className="truncate text-[10px] font-bold text-white/95">
          {extractBaseAsset(b.symbol)}
        </span>
        {resolved.showMarket && (
          <span className="shrink-0 text-[7px] text-white/70">{EXCHANGE_BADGE[b.exchange]}</span>
        )}
        {b.roundNumber && (
          <span className="shrink-0 w-[4px] h-[4px] rounded-full bg-white/90" />
        )}
        <span className="shrink-0 text-[9px] text-white/90 tabular-nums">
          {b.count > 1 ? `${b.count} ` : ''}{formatUsdt(b.sumUsdt)}
        </span>
      </button>
    )
  }

  const asks = blocks.filter(b => b.side === 'ask')
  const bids = blocks.filter(b => b.side === 'bid')

  return (
    <div className="w-full h-full flex flex-col bg-[#0a0a0a]">
      {/* Легенда-шапка (scalpboard: grid-cols-3 uppercase text-10px) */}
      <div className="grid grid-cols-3 uppercase text-[10px] leading-5 items-center text-center text-[#777] select-none h-[20px] border-b border-[#1f1f1f] bg-[#0e0e0e] flex-shrink-0">
        <div>{TIER_LABEL[1]}</div>
        <div>{TIER_LABEL[2]}</div>
        <div>{TIER_LABEL[3]}</div>
      </div>

      <div className="relative flex-1 min-h-0" onWheel={onWheel} data-testid="density-map">
        {/* АСКИ — верхняя зона */}
        <div className="absolute inset-x-0 top-0 h-1/2 overflow-hidden">
          {gridlines.map(y => (
            <div key={`ga-${y}`} className="absolute left-0 right-0 h-px bg-white/5 pointer-events-none" style={{ bottom: `${y}%` }} />
          ))}
          {asks.map(renderBlock)}
        </div>

        {/* БИДЫ — нижняя зона */}
        <div className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden">
          {gridlines.map(y => (
            <div key={`gb-${y}`} className="absolute left-0 right-0 h-px bg-white/5 pointer-events-none" style={{ top: `${y}%` }} />
          ))}
          {bids.map(renderBlock)}
        </div>

        {/* колонки-тиры */}
        {[1, 2].map(i => (
          <div
            key={i}
            className="absolute top-0 bottom-0 w-px bg-white/5 pointer-events-none"
            style={{ left: `${colW * i}%` }}
          />
        ))}

        {/* спред (центр) */}
        <div className="absolute left-0 right-0 top-1/2 h-px bg-[#444] pointer-events-none z-10" />
        <div className="absolute left-0 top-1/2 -translate-y-1/2 text-[9px] text-[#666] px-1 bg-[#0a0a0a] pointer-events-none select-none z-10">
          {zoomPct.toFixed(1)}%
        </div>

        {slots.size === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-[#555]">
            Плотностей нет — сервер собирает стаканы…
          </div>
        )}
      </div>
    </div>
  )
})
