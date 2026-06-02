# План: Редизайн авторизации и регистрации

## Решения из гриллинга

1. Email убран полностью. Вход по username. Восстановление пароля — через TG бота
2. Привязка Telegram **обязательна** при регистрации
3. Двухфазная регистрация: создаём аккаунт (telegramVerified=false) → привязка TG → success
4. При логине с telegramVerified=false — ошибка + ссылка на привязку. Без cron-очистки
5. Username: 3–20 символов, a-zA-Z0-9_, можно начинать с чего угодно
6. Пароль: минимум 6 символов, без требований к сложности
7. Поле «Повторите пароль» обязательно при регистрации
8. Поллинг GET /auth/telegram-status каждые 2–3 сек до подтверждения TG
9. После success-окна кнопка «Войти» → пустые поля (юзер вводит всё сам)
10. Auto-refresh JWT cookie: при активности продлевать, если токен стареет
11. Кнопка «Личный кабинет»: иконка User + текст
12. ProfileModal: логин + статус «Telegram: привязан» + «Выйти». Отвязка TG запрещена

---

## Шаги реализации

### Шаг 1: Бэкенд — schema + migration
- schema.prisma: email → username, добавить telegramVerified Boolean @default(false)
- prisma db push

### Шаг 2: Бэкенд — cookie-parser + cors
- npm i cookie-parser && npm i -D @types/cookie-parser
- index.ts: app.use(cookieParser()), cors({ origin: true, credentials: true })

### Шаг 3: Бэкенд — auth middleware
- Читать токен из req.cookies.token, fallback на Authorization
- JwtPayload: { userId, username }
- Auto-refresh: если токен стареет (<1д до истечения), пересоздать cookie

### Шаг 4: Бэкенд — auth routes
- POST /register: username + password → создать юзера с telegramVerified=false → JWT в cookie
- POST /login: username + password → если telegramVerified=false → 403 + ссылка на привязку → JWT в cookie
- POST /logout: clearCookie
- GET /me: вернуть username, telegramVerified, telegramChatId
- GET /telegram-status: вернуть { telegramVerified, telegramLink }
- Удалить /telegram-unbind

### Шаг 5: Фронтенд — AuthStore
- username вместо email, убрать localStorage
- checkSession() — GET /auth/me при старте
- login() — обновить стейт из ответа (токен в cookie)
- logout() — POST /auth/logout + сброс

### Шаг 6: Фронтенд — api.ts
- withCredentials: true
- Убрать Authorization interceptor
- Обновить 401-interceptor

### Шаг 7: Фронтенд — AuthModal
- Полноэкранный гейт, не закрываемый
- Вкладка «Регистрация»: логин + пароль + повтор пароля + кнопка «Зарегистрироваться»
- После регистрации → экран «Привяжите Telegram» с кнопкой → поллинг telegram-status
- После подтверждения TG → success-окно «Вы успешно зарегистрировались!» + кнопка «Войти»
- Вкладка «Вход»: логин + пароль + кнопка «Войти»
- Удалить LoginModal.tsx

### Шаг 8: Фронтенд — ProfileModal
- Заголовок «Личный кабинет»
- Показывает username, статус «Telegram: привязан»
- Кнопка «Выйти»
- Без отвязки TG

### Шаг 9: Фронтенд — TopBar
- Кнопка «Личный кабинет» (иконка User + текст)

### Шаг 10: Фронтенд — App.tsx
- checkSession() при маунте
- showAuth вместо showLogin, AuthModal вместо LoginModal

### Шаг 11: Тестирование
