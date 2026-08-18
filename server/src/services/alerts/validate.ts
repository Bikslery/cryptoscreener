import type { Exchange, ImpulseAlertCondition, ImpulseExchangeCondition, PriceAlertCondition, ListingAlertCondition } from '../../types.js'

// Manual condition validation (zod-style, zero dependencies).

export const VALID_EXCHANGES: readonly Exchange[] = ['binance-spot', 'binance-futures', 'bybit-futures']
const IMPULSE_TIMEFRAMES = ['1m', '5m'] as const
const IMPULSE_DIRECTIONS = ['up', 'down', 'both'] as const

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isFiniteNumberIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && isFinite(v) && v >= min && v <= max
}

export function validateImpulseCondition(raw: unknown): { condition: ImpulseAlertCondition } | { error: string } {
  if (!isRecord(raw)) return { error: 'condition должен быть объектом' }
  if (!isFiniteNumberIn(raw.percent, 0.01, 1000)) return { error: 'percent: число 0.01–1000' }
  if (typeof raw.timeframe !== 'string' || !(IMPULSE_TIMEFRAMES as readonly string[]).includes(raw.timeframe)) return { error: 'timeframe: 1m или 5m' }
  if (typeof raw.direction !== 'string' || !(IMPULSE_DIRECTIONS as readonly string[]).includes(raw.direction)) return { error: 'direction: up/down/both' }
  if (!isFiniteNumberIn(raw.volumeSpike, 0, 1000)) return { error: 'volumeSpike: число 0–1000 (0 = выкл)' }
  if (!Array.isArray(raw.exchanges) || raw.exchanges.length === 0 || raw.exchanges.length > 10) return { error: 'exchanges: массив 1–10 бирж' }
  const exchanges: ImpulseExchangeCondition[] = []
  const seen = new Set<string>()
  for (const item of raw.exchanges) {
    if (!isRecord(item)) return { error: 'exchanges: каждый элемент — объект' }
    if (typeof item.exchange !== 'string' || !VALID_EXCHANGES.includes(item.exchange as Exchange)) return { error: `exchanges: неизвестная биржа ${item.exchange}` }
    if (!isFiniteNumberIn(item.minVolume24h, 0, 1e15)) return { error: 'exchanges: minVolume24h — число ≥ 0' }
    if (seen.has(item.exchange as string)) continue
    seen.add(item.exchange as string)
    exchanges.push({ exchange: item.exchange as Exchange, minVolume24h: item.minVolume24h as number })
  }
  if (exchanges.length === 0) return { error: 'exchanges: массив 1–10 бирж' }
  if (raw.telegram !== undefined && typeof raw.telegram !== 'boolean') return { error: 'telegram: булево значение' }
  return {
    condition: {
      percent: raw.percent,
      timeframe: raw.timeframe as ImpulseAlertCondition['timeframe'],
      direction: raw.direction as ImpulseAlertCondition['direction'],
      volumeSpike: raw.volumeSpike,
      exchanges,
      // Telegram delivery is opt-in — absent means browser notifications only.
      telegram: raw.telegram === true,
      // lastFiredCandleTime is engine bookkeeping — never accepted from the client.
    },
  }
}

export function validatePriceCondition(raw: unknown): { condition: PriceAlertCondition } | { error: string } {
  if (!isRecord(raw)) return { error: 'condition должен быть объектом' }
  if (!isFiniteNumberIn(raw.price, 1e-12, 1e15)) return { error: 'price: положительное число' }
  if (raw.direction !== 'above' && raw.direction !== 'below') return { error: 'direction: above/below' }
  return { condition: { price: raw.price, direction: raw.direction } }
}

export function validateListingCondition(raw: unknown): { condition: ListingAlertCondition } | { error: string } {
  if (!isRecord(raw)) return { error: 'condition должен быть объектом' }
  if (typeof raw.exchange !== 'string' || !VALID_EXCHANGES.includes(raw.exchange as Exchange)) return { error: 'exchange: неизвестная биржа' }
  return { condition: { exchange: raw.exchange as Exchange } }
}
