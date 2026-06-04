# Plan: Telegram 1-to-1 binding + Auth UI cleanup

## Goal

1. **Telegram unique binding**: Один Telegram-аккаунт (chatId) можно привязать только к одному User. Сейчас бот просто пишет `telegramChatId` + `telegramVerified: true` — никакой проверки на дубликат.
2. **Auth UI**: Убрать символы `()` и `$` из текстов/плейсхолдеров AuthModal.

## Current context

### Schema (`prisma/schema.prisma`)
- `User.telegramChatId: String?` — нет `@unique`, нет индекса
- `User.telegramVerified: Boolean @default(false)`

### Bot bind logic (`server/src/services/telegram/bot.ts:48-69`)
```
/start bind_<userId> → findUnique(userId) → update { telegramChatId, telegramVerified: true }
```
Проверяется только что **этот** user ещё не привязан. Не проверяется, привязан ли этот chatId к другому user.

### Auth UI (`client/src/components/auth/AuthModal.tsx`)
- L165: `войти()` — кнопка после успешной регистрации
- L201: `$ логин` — placeholder
- L212: `$ пароль` — placeholder
- L223: `$ пароль` — placeholder (повтор)
- L233: `войти()` / `зарегистрироваться()` — кнопка формы

## Proposed approach

### Task 1: Telegram unique binding

**Шаг 1 — Миграция: добавить `@unique` на `telegramChatId`**

Файл: `server/prisma/schema.prisma`

```prisma
telegramChatId   String?  @unique
```

Проблема: в БД могут быть дубли chatId. Решение — удалить аккаунты-дубликаты перед миграцией:
1. Найти дубли: `SELECT telegramChatId FROM User WHERE telegramChatId IS NOT NULL GROUP BY telegramChatId HAVING COUNT(*) > 1`
2. Для каждого дубля — оставить первый (по createdAt) аккаунт, остальные удалить: `DELETE FROM User WHERE id IN (...)`

**Шаг 2 — Сгенерировать миграцию**

```bash
cd server && npx prisma migrate dev --name add-unique-telegram-chat-id
```

**Шаг 3 — Обновить bot.ts: проверка chatId при привязке**

Файл: `server/src/services/telegram/bot.ts`, функция `handleUpdate`, блок `bind_`

Перед `prisma.user.update` добавить:

```ts
// Проверяем, не привязан ли этот chatId к другому аккаунту
const existingBind = await prisma.user.findUnique({ where: { telegramChatId: chatId } })
if (existingBind) {
  if (existingBind.id === userId) {
    await sendTelegramMessage(chatId, 'ℹ️ Этот Telegram уже привязан к вашему аккаунту.')
  } else {
    await sendTelegramMessage(chatId, '❌ Этот Telegram-аккаунт уже привязан к другому пользователю. Один Telegram можно привязать только к одному аккаунту.')
  }
  return
}
```

Это сработает т.к. после `@unique` на `telegramChatId` `findUnique` по этому полю будет работать (Prisma требует `@unique` для `findUnique`).

**Шаг 4 — Обновить ответ бота при /start без параметров**

Уточнить приветствие: упомянуть что один Telegram — один аккаунт.

### Task 2: Auth UI — убрать `()` и `$`

Файл: `client/src/components/auth/AuthModal.tsx`

| Строка | Было | Стало |
|--------|------|-------|
| 165 | `войти()` | `войти` |
| 201 | `$ логин` | `логин` |
| 212 | `$ пароль` | `пароль` |
| 223 | `$ пароль` | `пароль` |
| 233 | `войти()` / `зарегистрироваться()` | `войти` / `зарегистрироваться` |

## Files to change

1. `server/prisma/schema.prisma` — `@unique` на `telegramChatId`
2. `server/src/services/telegram/bot.ts` — проверка duplicate chatId
3. `client/src/components/auth/AuthModal.tsx` — убрать `()` и `$`

## Validation

1. `npx prisma migrate dev` — миграция проходит без ошибок
2. `npx tsc -b` — типы в порядке (findUnique по telegramChatId работает)
3. `npx vite build` — клиент билдится
4. Ручная проверка: привязать один ТГ к двум аккаунтам — второй должен получить отказ

## Risks

- **Duplicate chatId в продакшн БД**: если данные уже есть, миграция упадёт. Нужно проверить перед деплоем. Если дубли есть — решить какой user оставить привязанным, остальные обнулить.
- **Prisma findUnique по nullable unique**: `findUnique({ where: { telegramChatId: chatId } })` не найдёт записи где `telegramChatId = null` — это правильно, null-значения не участвуют в unique constraint.
