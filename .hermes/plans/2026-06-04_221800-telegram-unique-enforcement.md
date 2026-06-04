# Plan: Запрет повторного использования Telegram-аккаунта

## Цель

Один Telegram-аккаунт (chatId) можно привязать **только к одному** User. При попытке привязать уже занятый ТГ:
1. **Бот** — сообщение: «Этот Telegram уже привязан к другому аккаунту. Привяжите другой Telegram.»
2. **Фронтенд** — окно/уведомление: «Telegram-аккаунт уже используется. Привяжите другой аккаунт.»

Сейчас бот **молча отвязывает** старый аккаунт (bot.ts:63-73) и привязывает ТГ к новому — это неправильно.

## Текущее состояние

### Schema
- `telegramChatId String? @unique` — unique constraint **уже добавлен** (миграция `20260605_add_unique_telegram_chat_id`).
- `telegramVerified Boolean @default(false)`

### Бот (bot.ts)
- Строки 63-73: `findFirst({ where: { telegramChatId: chatId } })` → если найден, **отвязывает** старый user (`telegramChatId: null, telegramVerified: false`) и привязывает к новому.
- Нужно **заменить** это на отказ с сообщением.

### Роут (auth.ts:85-97)
- `GET /auth/telegram-status` — возвращает `{ telegramVerified, telegramLink }`.
- Polling на фронте проверяет `telegramVerified` — если true, переходит к success.
- **Нет** поля для передачи ошибки «telegram уже занят».

### Фронтенд (AuthModal.tsx)
- Polling (`startPolling`) — проверяет только `res.data.telegramVerified`.
- Если polling таймаутится — показывает общую ошибку «Время ожидания истекло».
- **Нет** обработки случая «telegram уже привязан к другому аккаунту».

### ProfileModal.tsx
- Показывает статус «привязан / не привязан».
- **Нет** кнопки «привязать Telegram» (для перепривязки после ошибки).

---

## План

### Шаг 1 — Обновить bot.ts: отказ вместо перепривязки

Файл: `server/src/services/telegram/bot.ts`

Заменить блок строк 62-73 (проверка existing → unbind + bind) на:

```ts
// Проверяем, не привязан ли этот Telegram к другому аккаунту
const existingBind = await prisma.user.findUnique({
  where: { telegramChatId: chatId },
  select: { id: true },
})
if (existingBind) {
  if (existingBind.id === userId) {
    // Уже привязан к этому же аккаунту — просто подтвердим
    await sendTelegramMessage(chatId, 'ℹ️ Этот Telegram уже привязан к вашему аккаунту.')
  } else {
    // Привязан к другому аккаунту — отказ
    await sendTelegramMessage(
      chatId,
      '❌ Этот Telegram-аккаунт уже привязан к другому пользователю.\n\n' +
      'Один Telegram можно привязать только к одному аккаунту.\n' +
      'Пожалуйста, привяжите другой Telegram-аккаунт.'
    )
  }
  return
}
```

После этого блока — остальной код привязки (update user) остаётся без изменений.

### Шаг 2 — Добавить статус «telegram-already-bound» в API

Файл: `server/src/routes/auth.ts`

Обновить `GET /telegram-status`:

```ts
router.get('/telegram-status', authMiddleware, async (req, res) => {
  const { userId } = (req as any).user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramVerified: true, telegramChatId: true, id: true },
  })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  const telegramLink = `https://t.me/clinic_screenerbot?start=bind_${user.id}`

  // Проверяем: если у user'а нет chatId, но кто-то другой уже занял его chatId
  // Это не нужно — бот сам отказывает. Клиент просто получит telegramBindError при polling.

  res.json({ telegramVerified: user.telegramVerified, telegramLink })
})
```

Но нам нужно дать фронту понять что привязка **не удалась** из-за duplicate. Проблема: бот работает асинхронно, фронт только опрашивает `telegramVerified`.

**Решение**: добавить в User поле `telegramBindError: String?` — бот записывает туда ошибку, API её отдаёт, фронт показывает.

#### 2a — Schema: добавить `telegramBindError`

Файл: `server/prisma/schema.prisma`

```prisma
model User {
  ...
  telegramBindError String?
  ...
}
```

#### 2b — Миграция

```bash
cd server && npx prisma migrate dev --name add-telegram-bind-error
```

#### 2c — Обновить bot.ts: записывать ошибку в User

В блоке отказа (шаг 1), при `existingBind && existingBind.id !== userId`:

```ts
await prisma.user.update({
  where: { id: userId },
  data: { telegramBindError: 'Этот Telegram-аккаунт уже привязан к другому пользователю.' },
})
```

При успешной привязке — очистить:

```ts
await prisma.user.update({
  where: { id: userId },
  data: { telegramChatId: chatId, telegramVerified: true, telegramBindError: null },
})
```

#### 2d — Обновить API: возвращать `telegramBindError`

Файл: `server/src/routes/auth.ts`

```ts
select: { telegramVerified: true, telegramChatId: true, id: true, telegramBindError: true },
// ...
res.json({ telegramVerified: user.telegramVerified, telegramLink, telegramBindError: user.telegramBindError })
```

### Шаг 3 — Обновить фронтенд AuthModal.tsx

Файл: `client/src/components/auth/AuthModal.tsx`

#### 3a — Добавить state для ошибки привязки

```ts
const [bindError, setBindError] = useState('')
```

#### 3b — Обновить polling: проверять `telegramBindError`

В `startPolling`, внутри interval callback:

```ts
const res = await api.get('/auth/telegram-status')
if (res.data.telegramBindError) {
  stopPolling()
  setBindError(res.data.telegramBindError)
  return
}
if (res.data.telegramVerified) {
  stopPolling()
  setStep('success')
}
```

#### 3c — Показать ошибку в UI (шаг telegram)

В блоке `step === 'telegram'`, после текста «Ожидание подтверждения...», добавить:

```tsx
{bindError && (
  <div className="auth-bind-error">
    <div className="auth-bind-error-text">{bindError}</div>
    <button
      className="auth-btn"
      onClick={() => {
        setBindError('')
        startPolling()
      }}
    >
      Попробовать с другим Telegram
    </button>
  </div>
)}
```

При этом скрыть «Ожидание подтверждения...» если `bindError` задан:

```tsx
{!bindError && (
  <p className="auth-polling-text">Ожидание подтверждения привязки...</p>
)}
```

#### 3d — Добавить CSS

Файл: `client/src/components/auth/AuthModal.css`

```css
.auth-bind-error {
  margin-top: 1.2rem;
  text-align: center;
}
.auth-bind-error-text {
  color: #ff6b6b;
  margin-bottom: 0.8rem;
  font-size: 0.9rem;
  line-height: 1.4;
}
```

### Шаг 4 — (опционально) Добавить привязку Telegram из ProfileModal

Сейчас ProfileModal показывает «не привязан», но нет кнопки привязать. Если пользователь отвязал ТГ или ошибка — он не может перепривязать без перелогина.

Добавить кнопку «Привязать Telegram» рядом с бейджем «не привязан», которая открывает тот же flow (ссылка на бота + polling).

**Решение**: вынести Telegram bind flow в отдельный компонент и использовать и в AuthModal и в ProfileModal. Или проще — добавить ссылку на бота прямо в ProfileModal.

---

## Файлы

| Файл | Изменение |
|------|-----------|
| `server/prisma/schema.prisma` | Добавить `telegramBindError String?` |
| `server/src/services/telegram/bot.ts` | Заменить unbind→отказ + записывать/clear `telegramBindError` |
| `server/src/routes/auth.ts` | Возвращать `telegramBindError` в `/telegram-status` |
| `client/src/components/auth/AuthModal.tsx` | Обработка `telegramBindError` + UI ошибки |
| `client/src/components/auth/AuthModal.css` | Стили для `.auth-bind-error` |
| `client/src/components/auth/ProfileModal.tsx` | (опц.) Кнопка «Привязать Telegram» |

## Порядок выполнения

1. Schema + миграция (`telegramBindError`)
2. bot.ts (отказ + запись ошибки)
3. auth.ts (API возвращает ошибку)
4. AuthModal.tsx + CSS (фронтенд)
5. ProfileModal (опционально)
6. Тест: попытка привязать один ТГ ко второму аккаунту

## Проверка

1. `npx prisma migrate dev` — миграция без ошибок
2. `npx tsc -b` (server) — типы ок
3. `npx vite build` (client) — билд ок
4. Ручной тест:
   - Аккаунт A привязывает ТГ → успех
   - Аккаунт B пытается привязать тот же ТГ → бот пишет отказ, фронт показывает ошибку
   - Аккаунт B привязывает другой ТГ → успех

## Риски

- **Prisma unique на nullable**: `findUnique({ where: { telegramChatId } })` — работает только с `@unique` (уже есть). Null-значения не участвуют в unique constraint — ок.
- **Миграция добавляет колонку**: `telegramBindError` — nullable, без дефолта, безопасно для существующих данных.
- **Race condition**: два пользователя одновременно шлют `/start bind_...` с одного ТГ — второй получит отказ от бота (findUnique вернёт первого), первый уже привязан.
