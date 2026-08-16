import type { DensitySettings, DensityWall } from '../types'
import { effectiveBrp } from './density'

export type Tier = 1 | 2 | 3

/**
 * Аналог scalpboard `calcTier`: плотность попадает в категорию, только если
 * прожила >= lifetime тира И размер >= БРП × мультипликатор. Возвращается
 * первый (самый крупный) подходящий тир: 1=large, 2=medium, 3=small.
 */
export function calcTier(
  wall: DensityWall,
  settings: DensitySettings,
  autoBrp: number | null,
  now = Date.now(),
): Tier | undefined {
  const brp = effectiveBrp(wall.symbol, settings, autoBrp)
  if (!(brp > 0)) return undefined
  const ageMin = Math.max(0, (now - wall.bornAt) / 60000)
  const tiers: { mult: number; life: number }[] = [
    { mult: settings.multLarge, life: settings.lifeLarge },
    { mult: settings.multMedium, life: settings.lifeMedium },
    { mult: settings.multSmall, life: settings.lifeSmall },
  ]
  for (let i = 0; i < tiers.length; i++) {
    const { mult, life } = tiers[i]
    if (ageMin >= life && wall.sizeUsdt >= brp * mult) return (i + 1) as Tier
  }
  return undefined
}

export interface DensityItem {
  type: 'wall' | 'density'
  /** для wall — ближайшая плотность кластера; для density — сама стена */
  wall: DensityWall
  tier: Tier
  members: DensityWall[]
}

function withinSpread(a: number, b: number, pct: number): boolean {
  return (Math.abs(a - b) / Math.min(a, b)) * 100 <= pct
}

/**
 * scalpboard `processedDensitiesWalls`: жадная кластеризация плотностей
 * одного (exchange, symbol, side) по близости цены; кластер >= wallsMinSize
 * становится «стеной» с тиром = минимальный тир участников.
 */
export function clusterDensities(
  walls: DensityWall[],
  settings: DensitySettings,
  autoBrps: Map<string, number | null>,
): DensityItem[] {
  if (!settings.walls) {
    const out: DensityItem[] = []
    for (const w of walls) {
      const tier = calcTier(w, settings, autoBrps.get(`${w.exchange}:${w.symbol}`) ?? null)
      if (tier !== undefined) out.push({ type: 'density', wall: w, tier, members: [w] })
    }
    return out
  }

  const groups = new Map<string, DensityWall[]>()
  for (const w of walls) {
    const key = `${w.exchange}:${w.symbol}:${w.side}`
    const arr = groups.get(key)
    if (arr) arr.push(w)
    else groups.set(key, [w])
  }

  const out: DensityItem[] = []
  for (const group of groups.values()) {
    const side = group[0].side
    const tiered: { wall: DensityWall; tier: Tier }[] = []
    for (const w of group) {
      const tier = calcTier(w, settings, autoBrps.get(`${w.exchange}:${w.symbol}`) ?? null)
      if (tier !== undefined) tiered.push({ wall: w, tier })
    }
    if (tiered.length === 0) continue
    tiered.sort((a, b) =>
      side === 'ask' ? a.wall.price - b.wall.price : b.wall.price - a.wall.price,
    )

    const clusters: { wall: DensityWall; tier: Tier }[][] = []
    let current: { wall: DensityWall; tier: Tier }[] = [tiered[0]]
    for (let i = 1; i < tiered.length; i++) {
      const prev = current[current.length - 1]
      if (withinSpread(prev.wall.price, tiered[i].wall.price, settings.wallsMaxSpread)) {
        current.push(tiered[i])
      } else {
        clusters.push(current)
        current = [tiered[i]]
      }
    }
    clusters.push(current)

    for (const cluster of clusters) {
      if (cluster.length >= settings.wallsMinSize) {
        let tier: Tier = 3
        for (const c of cluster) if (c.tier < tier) tier = c.tier
        out.push({
          type: 'wall',
          wall: cluster[0].wall,
          tier,
          members: cluster.map((c) => c.wall),
        })
      } else {
        for (const c of cluster) {
          out.push({ type: 'density', wall: c.wall, tier: c.tier, members: [c.wall] })
        }
      }
    }
  }
  return out
}
