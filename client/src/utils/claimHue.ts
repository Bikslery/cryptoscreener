const GOLDEN = 137.508

const symbolHueIndex = new Map<string, number>()
let nextHueIndex = 0

/** Детерминированный индекс палитры для монеты: назначается в порядке
 *  первого появления (как у scalpboard, но без рандома между сессиями). */
export function hueIndexFor(symbol: string): number {
  let idx = symbolHueIndex.get(symbol)
  if (idx === undefined) {
    idx = nextHueIndex++
    symbolHueIndex.set(symbol, idx)
  }
  return idx
}

export function claimHue(seedIndex: number): { hue: number; lOffset: number } {
  const hue = (seedIndex * GOLDEN) % 360
  const lOffset = Math.min(seedIndex % 25, 24)
  return { hue, lOffset }
}

/** Цвет блока карты: hsla(hue, 40%, (70|40) - lOffset, 0.9) — тёмная тема. */
export function wallColor(hue: number, lOffset: number, isDark = true): string {
  const base = isDark ? 70 : 40
  return `hsla(${hue},40%,${Math.max(0, base - lOffset)}%,0.9)`
}
