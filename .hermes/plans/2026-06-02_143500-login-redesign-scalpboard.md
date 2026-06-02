# План: Редизайн страницы входа по образцу ScalpBoard

## Цель

Переделать внешний вид страницы входа (AuthModal) в crypto-screener, скопировав дизайн с https://scalpboard.io/ru/login. Добавить полноценный вход через Telegram. Упростить верификацию профиля — пользователь просто нажимает Start в боте.

## Решения (из grilled-интервью + обновления)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Табы вход/регистрация | **Убрать.** Только вход. Регистрация на отдельной странице |
| 2 | Кнопка «Войти через Telegram» | **Добавить.** Полноценный вход через бота |
| 3 | Карточка с бордером | **Убрать.** Чистая колонка на чёрном фоне |
| 4 | Лейблы над инпутами | **Убрать.** Только плейсхолдеры |
| 5 | Кнопка «Войти» серая/синяя | **Серая** когда пустая, нейтральная когда активная |
| 6 | Логотип + «Назад» | **Не добавлять** |
| 7 | Бот для верификации | **clinic_screenerbot** (token: `TELEGRAM_BOT_TOKEN` в .env) |
| 8 | Верификация Telegram | **Deep link** — юзер кликает ссылку → открывается Telegram → жмёт Start → всё. Никаких ручных команд |

## Telegram бот

- **Username:** `@clinic_screenerbot`
- **Token:** хранится в `server/.env` как `TELEGRAM_BOT_TOKEN=8937529946:***`
- **Режим:** polling (вебхук не установлен)
- **Текущий бот в коде (`bot.ts`):** ссылается на `ScalpBoardBot` — нужно заменить на `clinic_screenerbot`

### Поток верификации профиля (упрощённый)

Юзер не пишет никаких команд вручную. Deep link автоматически подставляет параметр:

1. После регистрации → сайт показывает кнопку «Привязать Telegram»
2. Кнопка — это ссылка `https://t.me/clinic_screenerbot?start=bind_USERID`
3. Юзер кликает → Telegram открывается → жмёт **Start** (Telegram автоматически отправляет `/start bind_USERID`)
4. Бот получает `/start bind_USERID`, обновляет `telegramChatId` + `telegramVerified = true`
5. Сайт поллит `/auth/telegram-status` → видит `telegramVerified: true` → вход

### Поток входа через Telegram (на странице логина)

1. Юзер кликает «Войти через Telegram»
2. Сайт вызывает `POST /auth/telegram-login-init` → создаёт `TelegramLoginSession` с уникальным токеном
3. Сайт открывает `https://t.me/clinic_screenerbot?start=login_TOKEN`
4. Юзер жмёт Start → бот получает `/start login_TOKEN`
5. Бот ищет юзера по `telegramChatId`, если найден — помечает сессию как подтверждённую
6. Сайт поллит `GET /auth/telegram-login-status?token=TOKEN` → при успехе получает JWT

## Контекст: текущая реализация

### Frontend (`client/src/components/auth/AuthModal.tsx`)
- Карточка `bg-zinc-900 border border-zinc-700 rounded-xl p-8 max-w-md`
- Табы Вход/Регистрация
- Лейблы «Логин», «Пароль» над полями
- Синяя кнопка `bg-blue-600`
- Шаг Telegram привязки после регистрации
- Шаг «Успешная регистрация»

### Backend (`server/src/routes/auth.ts`)
- `POST /auth/register` — создание пользователя + JWT
- `POST /auth/login` — вход по username/password, проверка `telegramVerified`
- `GET /auth/telegram-status` — статус привязки + ссылка на бота
- `POST /auth/logout`, `GET /auth/me`

### Баг: `telegramVerified` никогда не ставится `true`
В `bot.ts` строка 53: `update({ data: { telegramChatId: chatId } })` — не обновляет `telegramVerified`. Нужно добавить `telegramVerified: true`.

### БД (`server/prisma/schema.prisma`)
- User: `telegramChatId String?`, `telegramVerified Boolean @default(false)`
- Нет модели для Telegram-сессий входа

---

## Дизайн ScalpBoard (извлечённые стили)

| Элемент | Значение |
|---------|----------|
| Фон страницы | `rgb(10, 10, 11)` — `#0a0a0b` |
| Контейнер колонки | `w-80` (~260px), `flex-col`, `gap-6` (~24px), **без фона, без бордера** |
| Инпут-обёртка | `rounded-2 p-4 bg-neutral-800/80` → `rgba(38,38,38,0.8)`, border-radius 6.5px, padding 13px |
| Инпут текст | `text-white`, no border, no bg (прозрачный внутри обёртки) |
| Плейсхолдер логин | `"Логин, например: Oleg_21"` |
| Плейсхолдер пароль | `"Пароль"` |
| Кнопка Telegram | `bg-blue-500/10` → `rgba(59,130,246,0.1)`, текст `rgb(96,165,250)` (blue-400), `rounded-2 p-4`, font-weight 300 |
| Кнопка «Войти» | `bg-neutral-600` → `rgb(82,82,82)`, текст `rgb(23,23,23)`, `rounded-2 p-4`, width 260px |
| Кнопка «Войти» активная | Нейтральный стиль, не синий |

---

## Пошаговый план

### Фаза 1: Backend — Бот + верификация + вход через Telegram

**Файлы:** `server/.env`, `server/src/services/telegram/bot.ts`, `server/src/routes/auth.ts`, `server/prisma/schema.prisma`

#### Шаг 1.1: Обновить `.env` — добавить токен бота
- Добавить `TELEGRAM_BOT_TOKEN=8937529946:***` в `server/.env`

#### Шаг 1.2: Добавить модель `TelegramLoginSession` в schema.prisma
```prisma
model TelegramLoginSession {
  id          String   @id @default(cuid())
  token       String   @unique
  chatId      String?
  userId      String?
  verified    Boolean  @default(false)
  createdAt   DateTime @default(now())
  expiresAt   DateTime

  @@index([token])
  @@index([expiresAt])
}
```
Миграция: `npx prisma migrate dev --name telegram-login-sessions`

#### Шаг 1.3: Обновить `bot.ts`
- Заменить `ScalpBoardBot` → `clinic_screenerbot`
- Обработать `/start bind_USERID` — добавить `telegramVerified: true` (багфикс)
- Обработать `/start login_TOKEN` — найти сессию, сохранить `chatId`, найти юзера по `chatId`, пометить `verified=true` + `userId`
- Обычный `/start` (без параметра) — приветственное сообщение
- Отправить подтверждение юзеру: «✅ Аккаунт подтверждён!» или «✅ Вход подтверждён!»

#### Шаг 1.4: Обновить `auth.ts` — новые endpoints

**`POST /auth/telegram-login-init`**
- Генерирует UUID токен
- Создаёт `TelegramLoginSession` с `expiresAt = now() + 5min`
- Возвращает `{ link: "https://t.me/clinic_screenerbot?start=login_TOKEN", token }`

**`GET /auth/telegram-login-status?token=TOKEN`**
- Ищет сессию по токену
- Если `verified=true` + `userId` — генерирует JWT, ставит cookie, возвращает user
- Если не подтверждено — `{ verified: false }`
- Если истекло — `{ error: 'expired' }`

**Обновить `GET /auth/telegram-status`**
- Ссылка на бота: `https://t.me/clinic_screenerbot?start=bind_USERID` (вместо ScalpBoardBot)

**Обновить `POST /auth/login`**
- Ссылка в 403 ответе: `https://t.me/clinic_screenerbot?start=bind_USERID`

### Фаза 2: Frontend — Редизайн AuthModal

**Файл:** `client/src/components/auth/AuthModal.tsx`

#### Шаг 2.1: Полный редизайн JSX
- Убрать карточку (border, bg-zinc-900) → просто колонка на фоне
- Убрать табы вход/регистрация
- Убрать лейблы — оставить только плейсхолдеры
- Добавить кнопку «Войти через Telegram» (стиль ScalpBoard)
- Кнопка «Войти» — серая по умолчанию, активная при заполненных полях
- Ширина колонки `w-80` (~320px), gap-6

Примерная структура:
```tsx
<div className="w-full h-full flex items-center justify-center bg-[#0a0a0b]">
  <div className="flex flex-col w-80 items-center gap-6">
    {/* Кнопка Telegram */}
    <button onClick={handleTelegramLogin}
       className="w-full text-center rounded-xl p-3.5 bg-blue-500/10 text-blue-400 font-light hover:bg-blue-500/20 transition">
      Войти через Telegram
    </button>

    {/* Разделитель */}
    <div className="w-full flex items-center gap-3 text-neutral-500 text-sm">
      <div className="flex-1 h-px bg-neutral-800" />
      или
      <div className="flex-1 h-px bg-neutral-800" />
    </div>

    {/* Инпут логин */}
    <div className="w-full rounded-xl p-3.5 bg-neutral-800/80">
      <input type="text" placeholder="Логин, например: Oleg_21"
             className="w-full bg-transparent text-white outline-none placeholder-neutral-500" />
    </div>

    {/* Инпут пароль */}
    <div className="w-full rounded-xl p-3.5 bg-neutral-800/80">
      <input type="password" placeholder="Пароль"
             className="w-full bg-transparent text-white outline-none placeholder-neutral-500" />
    </div>

    {/* Кнопка Войти */}
    <button disabled={!canSubmit}
      className="w-full rounded-xl p-3.5 transition
        disabled:bg-neutral-600 disabled:text-neutral-900
        bg-neutral-500 text-neutral-900 hover:bg-neutral-400">
      Войти
    </button>

    {/* Ссылка на регистрацию */}
    <button onClick={switchToRegister}
      className="text-neutral-500 text-sm hover:text-neutral-300 transition">
      Зарегистрироваться
    </button>
  </div>
</div>
```

#### Шаг 2.2: Логика Telegram входа (polling)
- При клике «Войти через Telegram» — запросить `POST /auth/telegram-login-init`
- Получить ссылку + токен
- Открыть ссылку `https://t.me/clinic_screenerbot?start=login_TOKEN` (window.open)
- Начать polling `GET /auth/telegram-login-status?token=TOKEN` каждые 3с
- При успехе — `setUser()` из store

#### Шаг 2.3: Кнопка «Войти» — динамический стиль
- `disabled` когда username или password пустые
- Серый (neutral-600 bg, neutral-900 text) когда disabled
- Активный (neutral-500 bg, neutral-900 text) когда оба поля заполнены

#### Шаг 2.4: Обновить экран привязки Telegram
- Та же стилистика (без карточки, колонка)
- Кнопка «Привязать Telegram» — ссылка `https://t.me/clinic_screenerbot?start=bind_USERID`
- Текст: «Нажмите Start в боте для подтверждения»
- Polling `/auth/telegram-status`

### Фаза 3: Страница регистрации

**Новый файл:** `client/src/components/auth/RegisterPage.tsx`

#### Шаг 3.1: Создать отдельный компонент регистрации
- Тот же стиль (узкая колонка, без карточки, плейсхолдеры)
- Поля: Логин, Пароль, Повторите пароль
- Кнопка «Зарегистрироваться» (серая/активная как на странице входа)
- Ссылка «Уже есть аккаунт? Войти» — ведёт обратно на AuthModal
- После регистрации — шаг привязки Telegram

#### Шаг 3.2: Навигация между входом и регистрацией
- В AuthModal кнопка «Зарегистрироваться» внизу → переключает на RegisterPage
- В RegisterPage кнопка «Уже есть аккаунт? Войти» → переключает обратно
- Реализовать через состояние в `useUIStore` (showAuth: 'login' | 'register')

### Фаза 4: Верификация и деплой

#### Шаг 4.1: Локальная проверка
- Запустить dev-сервер
- Проверить: форма входа выглядит как ScalpBoard
- Проверить: Telegram вход работает (бот отвечает на `/start login_XXX`)
- Проверить: верификация профиля работает (бот ставит `telegramVerified: true`)
- Проверить: обычный вход работает
- Проверить: регистрация + привязка Telegram работает

#### Шаг 4.2: Деплой
- Миграция БД на VPS
- `cd client && npm run build`
- `cd server && npm run build`
- Закоммитить и пушить
- На VPS: `git pull && docker compose up -d --build`

---

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `server/.env` | Добавить `TELEGRAM_BOT_TOKEN` |
| `server/prisma/schema.prisma` | Добавить `TelegramLoginSession` |
| `server/src/services/telegram/bot.ts` | Заменить ScalpBoardBot→clinic_screenerbot, багфикс `telegramVerified`, добавить `/start login_TOKEN` |
| `server/src/routes/auth.ts` | 2 новых endpoint, обновить ссылки бота |
| `client/src/components/auth/AuthModal.tsx` | Полный редизайн + логика Telegram входа |
| `client/src/components/auth/RegisterPage.tsx` | **Новый** — отдельная страница регистрации |
| `client/src/App.tsx` | Интеграция RegisterPage (переключение) |
| `client/src/store/index.ts` | Добавить состояние auth page switch |

## Риски и открытые вопросы

1. **Deep link fallback** — `https://t.me/...` работает везде, `tg://resolve?domain=...` может не работать в некоторых браузерах. Используем `https://t.me/...`
2. **TelegramLoginSession TTL** — 5 минут. Истёкшие сессии нужно чистить (cron или при следующем запросе)
3. **Polling vs cookie** — `GET /auth/telegram-login-status` при успехе ставит JWT cookie через `setAuthCookie`. Это работает т.к. SameSite=Lax и домен тот же
4. **Миграция БД** — нужно запустить на VPS, даунтайм минимальный
5. **CRLF** — файлы проекта с CRLF, использовать Python для find-replace или patch tool
6. **Бот уже используется** — `clinic_screenerbot` не имеет вебхука, polling свободен. Нужно убедиться что старый `ScalpBoardBot` токен удалён из .env если он там был
