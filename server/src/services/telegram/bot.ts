import { prisma } from '../../db/index.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`

export const TELEGRAM_BOT_USERNAME = 'clinic_screenerbot'

export async function sendTelegramMessage(chatId: string, text: string) {
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const data = await res.json() as any
    if (!data.ok) {
      console.error('[Telegram] sendMessage failed:', data.description)
    }
    return data.ok
  } catch (err) {
    console.error('[Telegram] sendMessage error:', err)
    return false
  }
}

export async function getBotInfo() {
  try {
    const res = await fetch(`${API_BASE}/getMe`)
    const data = await res.json() as any
    return data.ok ? data.result : null
  } catch {
    return null
  }
}

export async function handleUpdate(update: any) {
  const message = update.message || update.callback_query?.message
  if (!message) return

  const chatId = String(message.chat.id)
  const text = update.message?.text || ''

  if (text.startsWith('/start')) {
    const args = text.split(' ')[1] || ''
    if (args.startsWith('bind_')) {
      const userId = args.replace('bind_', '')
      try {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { telegramVerified: true } })
        if (!user) {
          await sendTelegramMessage(chatId, '❌ Пользователь не найден.')
          return
        }
        if (user.telegramVerified) {
          await sendTelegramMessage(chatId, 'ℹ️ Этот аккаунт уже привязан к Telegram.')
          return
        }
        // Check if this Telegram account is already bound to another user
        const existingBind = await prisma.user.findUnique({
          where: { telegramChatId: chatId },
          select: { id: true },
        })
        if (existingBind) {
          if (existingBind.id === userId) {
            await sendTelegramMessage(chatId, 'ℹ️ Этот Telegram уже привязан к вашему аккаунту.')
          } else {
            await prisma.user.update({
              where: { id: userId },
              data: { telegramBindError: 'Этот Telegram-аккаунт уже привязан к другому пользователю.' },
            })
            await sendTelegramMessage(
              chatId,
              '❌ Этот Telegram-аккаунт уже привязан к другому пользователю.\n\n' +
              'Один Telegram можно привязать только к одному аккаунту.\n' +
              'Пожалуйста, привяжите другой Telegram-аккаунт.'
            )
          }
          return
        }
        await prisma.user.update({
          where: { id: userId },
          data: { telegramChatId: chatId, telegramVerified: true, telegramBindError: null },
        })
        await sendTelegramMessage(chatId, '✅ Telegram успешно привязан к вашему аккаунту!')
      } catch (err) {
        await sendTelegramMessage(chatId, '❌ Не удалось привязать аккаунт. Попробуйте снова или обратитесь в поддержку.')
      }
    } else {
      await sendTelegramMessage(
        chatId,
        `👋 Добро пожаловать в Crypto Screener Bot!\n\n` +
        `Для привязки аккаунта зарегистрируйтесь на сайте — ссылка для привязки появится автоматически.\n\n` +
        `Уведомления:\n` +
        `• Пересечение ценовых уровней\n` +
        `• Резкие импульсы рынка\n` +
        `• Новые листинги`
      )
    }
  }
}

let offset = 0
let pollingActive = false

export function startTelegramPolling() {
  if (!BOT_TOKEN) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set, polling disabled')
    return
  }
  if (pollingActive) return
  pollingActive = true
  console.log('[Telegram] Starting polling...')

  async function poll() {
    if (!pollingActive) return
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30000)
      const res = await fetch(`${API_BASE}/getUpdates?offset=${offset}&limit=10`, { signal: ctrl.signal })
      clearTimeout(timer)
      const data = await res.json() as any
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1
          await handleUpdate(update)
        }
      }
    } catch {
      // Network errors are expected during polling
    }
    setTimeout(poll, 1000)
  }

  poll()
}

export function stopTelegramPolling() {
  pollingActive = false
}
