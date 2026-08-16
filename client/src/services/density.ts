import type {
  DensitySettings,
  DensitySnapshot,
  DensityCell,
  DensityWall,
  Exchange,
} from '../types'

export const DEFAULT_DENSITY_SETTINGS: DensitySettings = {
  mode: 'auto',
  manualBrp: 500_000,
  // scalpboard-математика тиров (×2/×3.5/×5 из их бандла), но время жизни
  // по просьбе пользователя 5 минут вместо их 30: плотность должна 5 минут
  // простоять на месте, чтобы появиться — спуф-фильтр + терпимое ожидание.
  multSmall: 2,
  multMedium: 3.5,
  multLarge: 5,
  lifeSmall: 5,
  lifeMedium: 5,
  lifeLarge: 5,
  perSymbol: {},
  zoomPct: 3,
  walls: false,
  wallsMaxSpread: 0.5,
  wallsMinSize: 3,
  showMarket: true,
  showSmall: true,
  showMedium: true,
  showLarge: true,
  hiddenSymbols: [],
}

export function resolveDensitySettings(patch?: Partial<DensitySettings>): DensitySettings {
  return {
    ...DEFAULT_DENSITY_SETTINGS,
    ...(patch ?? {}),
    perSymbol: { ...(patch?.perSymbol ?? {}) },
  }
}

export const EXCHANGE_BADGE: Record<Exchange, string> = {
  'binance-spot': 'BI-S',
  'binance-futures': 'BI-F',
  'bybit-futures': 'BY-F',
  'okx-spot': 'OK-S',
  'okx-futures': 'OK-F',
}

export const EXCHANGE_COLOR: Record<Exchange, string> = {
  'binance-spot': '#f0b90b',
  'binance-futures': '#f0b90b',
  'bybit-futures': '#ff8a1e',
  'okx-spot': '#7c8bff',
  'okx-futures': '#7c8bff',
}

/** Effective БРП for a symbol: per-symbol override → manual → auto. */
export function effectiveBrp(
  symbol: string,
  settings: DensitySettings,
  autoBrp: number | null,
): number {
  const override = settings.perSymbol[symbol]
  if (override !== undefined && isFinite(override) && override > 0) return override
  if (settings.mode === 'manual') return settings.manualBrp
  if (autoBrp !== null && isFinite(autoBrp) && autoBrp > 0) return autoBrp
  return settings.manualBrp
}

export function categorizeSize(
  sizeUsdt: number,
  brp: number,
  multMedium: number,
  multLarge: number,
): DensityCell['category'] {
  if (sizeUsdt >= brp * multLarge) return 'large'
  if (sizeUsdt >= brp * multMedium) return 'medium'
  return 'small'
}

/** Convert a raw server wall into a display cell with user-specific
 *  categorization and distance from the current price. */
export function toDensityCell(
  wall: DensityWall,
  settings: DensitySettings,
  autoBrp: number | null,
  currentPrice: number,
  pricePrecision: number,
): DensityCell {
  const brp = effectiveBrp(wall.symbol, settings, autoBrp)
  return {
    symbol: wall.symbol,
    exchange: wall.exchange,
    side: wall.side,
    price: wall.price,
    sizeUsdt: wall.sizeUsdt,
    bornAt: wall.bornAt,
    roundNumber: wall.roundNumber,
    distancePct: currentPrice > 0 ? ((wall.price - currentPrice) / currentPrice) * 100 : 0,
    category: categorizeSize(wall.sizeUsdt, brp, settings.multMedium, settings.multLarge),
    pricePrecision,
  }
}

export function autoBrpMap(snapshot: DensitySnapshot): Map<string, number | null> {
  const map = new Map<string, number | null>()
  for (const b of snapshot.autoBrps) {
    map.set(`${b.exchange}:${b.symbol}`, b.autoBrp)
  }
  return map
}

export function formatUsdt(sizeUsdt: number): string {
  if (sizeUsdt >= 1_000_000) return `${(sizeUsdt / 1_000_000).toFixed(2)}M`
  if (sizeUsdt >= 1_000) return `${(sizeUsdt / 1_000).toFixed(1)}K`
  return sizeUsdt.toFixed(0)
}

export function formatAge(bornAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - bornAt) / 1000))
  if (sec < 60) return `${sec}с`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}м`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}ч${min % 60}м`
  return `${Math.floor(h / 24)}д${h % 24}ч`
}
