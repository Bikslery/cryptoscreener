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
/** scalpboard dark theme: asks zone red, bids zone green */
const MAP_TOP = '#bc3838'
const MAP_BOTTOM = '#38bc38'
const FOREGROUND_FULL = '#0d0d0d'

/** Точная копия их zone-фона (yt из бандла): linear-gradient(to left) из
 *  tier-колонок с альфой 0.11 → 0.02 — правая колонка (Малые) насыщеннее. */
function zoneBackground(color: string, tiers = TIER_COUNT): string {
  const colW = 100 / tiers
  const aFrom = 0.11
  const aTo = 0.02
  const step = (aFrom - aTo) / (tiers - 1)
  const stops: string[] = []
  for (let u = 0; u < tiers; u++) {
    const alpha = Number((aTo + step * u).toFixed(3))
    const rgba = withAlpha(color, alpha)
    stops.push(`${rgba} ${u * colW}%`, `${rgba} ${(u + 1) * colW}%`)
  }
  return `linear-gradient(to left, ${stops.join(', ')})`
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

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
 * Карта плотностей — копия scalpboard AppMap/AppMapWall: центр — спред,
 * верхняя зона (аски) с красным градиентом, нижняя (биды) с зелёным;
 * полосы расстояний каждые 0.5% с подписями (0.5%…3% при глубине 3);
 * блок стоит ровно на своей дистанции и ПЛАВНО перетекает между полосами
 * и колонками тиров (CSS transition).
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

  /** Полосы расстояний: ceil(глубина/0.5) тиков, подпись i/2% (их формула). */
  const ticks = useMemo(() => {
    const count = Math.ceil(zoomPct / 0.5)
    return Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({
      pos: ((i + 1) * (100 / count)),
      label: `${(i + 1) / 2}%`,
      big: (i + 1) % 2 === 1,
    }))
  }, [zoomPct])

  const colW = 100 / TIER_COUNT

  const renderBlock = (b: MapBlock) => {
    if (Math.abs(b.distancePct) > zoomPct) return null
    const key = `${b.exchange}:${b.symbol}:${b.side}:${b.price}`
    const left = colW * b.tier - colW / 2
    const color = wallColor(b.hue, b.lOffset)
    const focused = focusedKey === key
    const yPct = Math.min(100, Math.max(0, (Math.abs(b.distancePct) / zoomPct) * 100))
    return (
      <button
        key={key}
        className={`absolute flex items-center gap-[3px] px-[5px] h-[20px] rounded-[3px] cursor-pointer border text-left will-change-[top,bottom,left] ${
          focused ? 'brightness-150' : 'hover:brightness-125'
        }`}
        style={{
          zIndex: focused ? 200 : 99,
          left: `${left}%`,
          width: `${colW - 6}%`,
          // аски прижаты к линии сверху, биды — снизу (2px от центра);
          // переходы — блоки плавно текут между полосами и колонками тиров
          ...(b.side === 'ask'
            ? { bottom: `${yPct}%`, transform: 'translateX(-50%) translateY(calc(-100% - 2px))' }
            : { top: `${yPct}%`, transform: 'translateX(-50%) translateY(2px)' }),
          backgroundColor: color,
          transition: 'top 600ms ease-out, bottom 600ms ease-out, left 600ms ease-out, background-color 600ms ease-out',
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
  const askZoneBg = useMemo(() => zoneBackground(MAP_TOP), [])
  const bidZoneBg = useMemo(() => zoneBackground(MAP_BOTTOM), [])

  return (
    <div className="relative w-full h-full bg-[#0a0a0a]" onWheel={onWheel} data-testid="density-map">
      {/* АСКИ — верхняя зона (красный градиент тиров) */}
      <div className="absolute inset-x-0 top-0 h-1/2 overflow-hidden" style={{ background: askZoneBg }}>
        {ticks.map(t => (
          <div
            key={`ta-${t.label}`}
            className="absolute left-0 right-0 flex items-center pointer-events-none"
            style={{ bottom: `${t.pos}%`, height: 0 }}
            data-testid="density-map-tick"
          >
            <div className="flex-1 h-px bg-white/8" />
            <span className={`absolute left-1 ${t.big ? 'text-[11px]' : 'text-[9px]'} text-[#888] bg-transparent pl-[2px]`}>
              {t.label}
            </span>
          </div>
        ))}
        {asks.map(renderBlock)}
        {/* легенда тиров — у линии центра, как у них */}
        <div className="absolute inset-x-0 bottom-0 h-[20px] grid grid-cols-3 uppercase text-[10px] leading-[20px] items-center text-center text-[#999] select-none pointer-events-none z-[6]">
          <div>{TIER_LABEL[1]}</div>
          <div>{TIER_LABEL[2]}</div>
          <div>{TIER_LABEL[3]}</div>
        </div>
      </div>

      {/* БИДЫ — нижняя зона (зелёный градиент тиров) */}
      <div className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden" style={{ background: bidZoneBg }}>
        {ticks.map(t => (
          <div
            key={`tb-${t.label}`}
            className="absolute left-0 right-0 flex items-center pointer-events-none"
            style={{ top: `${t.pos}%`, height: 0 }}
            data-testid="density-map-tick"
          >
            <div className="flex-1 h-px bg-white/8" />
            <span className={`absolute left-1 ${t.big ? 'text-[11px]' : 'text-[9px]'} text-[#888] bg-transparent pl-[2px]`}>
              {t.label}
            </span>
          </div>
        ))}
        {bids.map(renderBlock)}
      </div>

      {/* виньетки 5% (их before/after слои) */}
      <div className="absolute inset-x-0 top-0 h-[5%] pointer-events-none z-[7]" style={{ opacity: 0.05, background: `linear-gradient(to bottom, ${FOREGROUND_FULL}, transparent)` }} />
      <div className="absolute inset-x-0 bottom-0 h-[5%] pointer-events-none z-[7]" style={{ opacity: 0.05, background: `linear-gradient(to top, ${FOREGROUND_FULL}, transparent)` }} />

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
      <div className="absolute left-1 top-1/2 -translate-y-1/2 text-[9px] text-[#777] px-1 bg-[#0a0a0a]/80 pointer-events-none select-none z-10">
        {zoomPct.toFixed(1)}%
      </div>

      {asks.length === 0 && bids.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-[#555] z-20">
          Плотностей нет — сервер собирает стаканы…
        </div>
      )}
    </div>
  )
})
