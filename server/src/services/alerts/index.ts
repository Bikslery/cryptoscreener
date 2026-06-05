import { getTickers } from '../aggregator/index.js'
import { broadcast } from '../../ws/hub.js'
import { prisma } from '../../db/index.js'
import { sendTelegramMessage } from '../telegram/bot.js'
import type { PriceAlertCondition, ImpulseAlertCondition } from '../../types.js'
import { formatPriceByPrecision, extractBaseAsset } from '../../utils/format.js'

let checkInterval: ReturnType<typeof setInterval> | null = null

export function startAlertEngine() {
  checkInterval = setInterval(async () => {
    try {
      const activeAlerts = await prisma.alert.findMany({
        where: { active: true, muted: false },
        take: 500,
      })

      const tickers = getTickers()
      const tickerBySymbol = new Map(tickers.map(t => [t.symbol, t]))

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
          const impulseCond = cond as ImpulseAlertCondition
          const matchingTickers = tickers.filter(t =>
            Math.abs(t.change24h) >= impulseCond.percent
          )
          // Batch: fire once per alert, include all matching symbols
          // Instead of N separate prisma updates + broadcasts per ticker
          if (matchingTickers.length > 0) {
            await fireAlert(alert, matchingTickers[0].price, matchingTickers[0].symbol, matchingTickers[0].pricePrecision)
            // Send additional symbols as separate broadcast events (no extra prisma writes)
            for (let i = 1; i < Math.min(matchingTickers.length, 10); i++) {
              const t = matchingTickers[i]
              broadcast({
                type: 'alert',
                data: {
                  id: alert.id,
                  type: alert.type,
                  symbol: t.symbol,
                  exchange: alert.exchange,
                  price: t.price,
                  condition: JSON.parse(alert.condition),
                  triggeredAt: Date.now(),
                },
              })
            }
          }
        }
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

async function fireAlert(alert: any, price: number, overrideSymbol?: string, pricePrecision?: number) {
  await prisma.alert.update({
    where: { id: alert.id },
    data: { triggeredAt: new Date(), active: false },
  })

  const symbol = overrideSymbol || alert.symbol
  const alertData = {
    id: alert.id,
    type: alert.type,
    symbol,
    exchange: alert.exchange,
    price,
    condition: JSON.parse(alert.condition),
    triggeredAt: Date.now(),
  }

  broadcast({ type: 'alert', data: alertData })

  const user = await prisma.user.findUnique({
    where: { id: alert.userId },
    select: { telegramChatId: true },
  })

  if (user?.telegramChatId) {
    const icon = alert.type === 'price' ? '📈' : alert.type === 'impulse' ? '⚡' : '🆕'
    const typeLabel = alert.type === 'price' ? 'Пересечение цены' : alert.type === 'impulse' ? 'Импульс' : 'Листинг'
    const formattedPrice = formatPriceByPrecision(price, pricePrecision ?? 2)
    const text = `${icon} <b>${typeLabel}</b>\n\n` +
      `<b>${extractBaseAsset(symbol)}</b>\n` +
      `Цена: $${formattedPrice}\n` +
      `Биржа: ${alert.exchange || 'N/A'}`
    await sendTelegramMessage(user.telegramChatId, text)
  }
}
