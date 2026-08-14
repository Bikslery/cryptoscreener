import { getTickers, getAllTickers, fetchCandles, anyLimiterOverThreshold } from '../aggregator/index.js'
import { getCachedCandles, setCachedCandles } from '../candles/candle-cache.js'
import { broadcast } from '../../ws/hub.js'
import { getRedisPub, REDIS_ENABLED } from '../../redis.js'
import { prisma } from '../../db/index.js'
import { sendTelegramMessage } from '../telegram/bot.js'
import { pickExchangeTicker, lastCandleIndex, matchesImpulseCandle, normalizeImpulseCondition } from './impulse.js'
import type { PriceAlertCondition, ImpulseAlertCondition, UnifiedCandle, UnifiedTicker } from '../../types.js'
import { formatPriceByPrecision, extractBaseAsset } from '../../utils/format.js'

let checkInterval: ReturnType<typeof setInterval> | null = null

const IMPULSE_SCAN_LIMIT = 200
const WARM_TOP_N = 200
const WARM_BATCH = 15
const WARM_CANDLE_LIMIT = 40
let warmCursor = 0

export function startAlertEngine() {
  checkInterval = setInterval(async () => {
    try {
      // Every active alert fires on every match — there is no mute/off switch
      // in the product: an alert is always armed once created, and impulse
      // alerts re-arm after each firing (price alerts are one-shot by design).
      const activeAlerts = await prisma.alert.findMany({
        where: { active: true },
        take: 500,
      })

      const tickers = getTickers()
      const tickerBySymbol = new Map(tickers.map(t => [t.symbol, t]))

      const impulseTfs = new Set<string>()
      for (const alert of activeAlerts) {
        if (alert.type !== 'impulse') continue
        impulseTfs.add(normalizeImpulseCondition(JSON.parse(alert.condition)).timeframe)
      }

      for (const alert of activeAlerts) {
        const cond = JSON.parse(alert.condition)

        if (alert.type === 'price') {
          const ticker = tickerBySymbol.get(alert.symbol)
          if (!ticker) continue
          const priceCond = cond as PriceAlertCondition
          const triggered = priceCond.direction === 'above'
            ? ticker.price >= priceCond.price
            : ticker.price <= priceCond.price

          if (triggered) {
            await fireAlert(alert, ticker.price, undefined, ticker.pricePrecision)
          }
        } else if (alert.type === 'impulse') {
          const match = await findImpulseMatch(alert.symbol, normalizeImpulseCondition(cond))
          if (match) {
            await fireAlert(alert, match.ticker.price, match.ticker.symbol, match.ticker.pricePrecision, {
              keepActive: true,
              impulseCandleTime: match.candle.time,
              movePct: match.movePct,
            })
          }
        }
      }

      if (impulseTfs.size > 0) {
        await warmCandleCache(impulseTfs)
      }
    } catch (e) {
      console.error('[AlertEngine] Error checking alerts:', e instanceof Error ? e.message : e)
    }
  }, 5000)
}

export function stopAlertEngine() {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}

/**
 * Scan the top coins for the first symbol satisfying ALL impulse conditions:
 * exchange priority + min 24h volume from the ticker, the LAST candle (may
 * still be forming — alerts fire as soon as the data shows the move, not at
 * candle close), movement >= percent% with the right direction, and a volume
 * spike vs the 30-candle baseline (when enabled). lastFiredCandleTime stops
 * refiring on the same candle.
 */
async function findImpulseMatch(symbol: string, cond: ImpulseAlertCondition): Promise<{ ticker: UnifiedTicker; candle: UnifiedCandle; movePct: number } | null> {
  const allTickers = getAllTickers()
  const bySymbol = new Map<string, Map<string, UnifiedTicker>>()
  for (const t of allTickers) {
    let m = bySymbol.get(t.symbol)
    if (!m) {
      m = new Map()
      bySymbol.set(t.symbol, m)
    }
    m.set(t.exchange, t)
  }

  const top = getTickers()
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, IMPULSE_SCAN_LIMIT)

  for (const coin of top) {
    if (symbol !== 'ANY' && coin.symbol !== symbol) continue

    // Exchange choice follows the condition's array order (priority).
    const ticker = pickExchangeTicker(bySymbol, coin.symbol, cond.exchanges)
    if (!ticker) continue

    const candles = getCachedCandles(coin.symbol, cond.timeframe, ticker.exchange)
    if (!candles || candles.length < 2) continue

    // The last candle qualifies even while forming — the alert fires the
    // moment the data shows the move; the dedupe below (per candle time)
    // prevents firing again as the same candle keeps growing.
    const idx = lastCandleIndex(candles)
    const candle = candles[idx]
    if (candle.time <= (cond.lastFiredCandleTime || 0)) continue

    if (!matchesImpulseCandle(cond, candle, candles.slice(Math.max(0, idx - 30), idx))) continue

    const movePct = candle.low > 0 ? ((candle.high - candle.low) / candle.low) * 100 : 0
    return { ticker, candle, movePct: Math.round(movePct * 100) / 100 }
  }
  return null
}

/**
 * Keep 1m/5m candle caches warm for the top coins that no client chart is
 * subscribed to — the impulse engine reads ONLY the cache, so unwatched
 * symbols must get their candles from REST. Cache-first, rotating cursor,
 * bounded batch per tick, rate-limiter aware (same pattern computeMetrics
 * uses for its REST fallbacks).
 */
async function warmCandleCache(tfs: Set<string>): Promise<void> {
  const top = getTickers()
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, WARM_TOP_N)
  if (top.length === 0) return

  for (const tf of tfs) {
    if (anyLimiterOverThreshold()) break
    let fetched = 0
    for (let i = 0; i < top.length && fetched < WARM_BATCH; i++) {
      const coin = top[(warmCursor + i) % top.length]
      const cached = getCachedCandles(coin.symbol, tf, coin.exchange)
      if (cached && cached.length >= 2) continue
      const candles = await fetchCandles(coin.symbol, tf, WARM_CANDLE_LIMIT, coin.exchange).catch(() => [])
      if (candles.length > 0) {
        setCachedCandles(coin.symbol, tf, candles, coin.exchange)
      }
      fetched++
    }
  }
  warmCursor = (warmCursor + WARM_BATCH) % Math.max(top.length, 1)
}

function publishAlert(data: unknown) {
  if (!REDIS_ENABLED) return
  try {
    getRedisPub().publish('alerts', JSON.stringify(data)).catch(() => {})
  } catch { /* redis down */ }
}

interface FireOptions {
  keepActive?: boolean
  impulseCandleTime?: number
  movePct?: number
}

async function fireAlert(alert: any, price: number, overrideSymbol?: string, pricePrecision?: number, opts: FireOptions = {}) {
  const symbol = overrideSymbol || alert.symbol
  const condition = JSON.parse(alert.condition)
  if (opts.impulseCandleTime !== undefined) {
    condition.lastFiredCandleTime = opts.impulseCandleTime
  }

  await prisma.alert.update({
    where: { id: alert.id },
    data: {
      triggeredAt: new Date(),
      ...(opts.keepActive ? {} : { active: false }),
      ...(opts.impulseCandleTime !== undefined ? { condition: JSON.stringify(condition) } : {}),
    },
  })

  const alertData = {
    id: alert.id,
    type: alert.type,
    symbol,
    exchange: alert.exchange,
    price,
    condition,
    triggeredAt: Date.now(),
    active: opts.keepActive ? true : false,
    ...(opts.movePct !== undefined ? { movePct: opts.movePct } : {}),
  }

  broadcast({ type: 'alert', data: alertData })
  publishAlert(alertData)

  const user = await prisma.user.findUnique({
    where: { id: alert.userId },
    select: { telegramChatId: true },
  })

  // Telegram delivery rules: impulse alerts are opt-in (condition.telegram),
  // regular price/listing alerts always notify in Telegram once bound.
  if (user?.telegramChatId && (condition.telegram === true || alert.type !== 'impulse')) {
    const icon = alert.type === 'price' ? '📈' : alert.type === 'impulse' ? '⚡' : '🆕'
    const typeLabel = alert.type === 'price' ? 'Пересечение цены' : alert.type === 'impulse' ? 'Импульс' : 'Листинг'
    const formattedPrice = formatPriceByPrecision(price, pricePrecision ?? 2)
    let text = `${icon} <b>${typeLabel}</b>\n\n` +
      `<b>${extractBaseAsset(symbol)}</b>\n` +
      `Цена: $${formattedPrice}\n` +
      `Биржа: ${alert.exchange || 'N/A'}`
    if (alert.type === 'impulse') {
      const dir = condition.direction === 'up' ? 'вверх' : condition.direction === 'down' ? 'вниз' : 'любое'
      text += `\nТФ: ${condition.timeframe} · направление: ${dir}` +
        (opts.movePct !== undefined ? ` · движение: ${opts.movePct}%` : '') +
        (condition.volumeSpike > 0 ? ` · объём ×${condition.volumeSpike}` : '')
    }
    await sendTelegramMessage(user.telegramChatId, text)
  }
}
