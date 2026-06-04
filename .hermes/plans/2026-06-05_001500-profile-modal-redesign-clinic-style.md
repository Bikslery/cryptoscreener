# ProfileModal редизайн — .clinic glow эстетика

## Цель

Переработать дизайн ProfileModal (личный кабинет пользователя) в стиле .clinic — убрать inline Tailwind, заменить на отдельный CSS-файл с glow-переменными, CursorGlow + Particles фон, uppercase лейблы, терминальный стиль.

## Контекст

- AuthModal уже переработан (коммит `687206a`) — там есть AuthModal.css, CursorGlow.tsx, Particles.tsx, CSS-переменные в index.css
- ProfileModal сейчас: 52 строки, inline Tailwind (`bg-zinc-900`, `border-zinc-700`, `text-red-400`), минимум информации (username + telegram status + logout)
- ProfileModal отображается как overlay (`fixed inset-0 z-50`) из App.tsx, открывается по кнопке «Личный кабинет» в TopBar
- Store: `useAuthStore` → `username`, `telegramVerified`, `logout`; `useUIStore` → `showProfile`, `setShowProfile`

## Стиль .clinic — референс

Из ProfileEdit.css / Admin.css .clinic:
- **Секции** — `.section` / `.card`: `bg-card`, `border rgba(255,255,255,0.06)`, `border-radius radius-lg`, `box-shadow shadow-card, glow-border`, hover → `border rgba(255,255,255,0.12)`, `glow-border-hover`
- **Заголовки секций** — `.section-header`: иконка 28x28 + h2, uppercase лейблы
- **Поля** — `.field label`: `0.72rem`, `uppercase`, `letter-spacing 0.5px`, `color rgba(255,255,255,0.35)`
- **Avatar** — круг, `border rgba(255,255,255,0.15)`, `box-shadow glow-border`, placeholder с первой буквой
- **Кнопки** — прозрачный фон, `border rgba(255,255,255,0.2)`, hover → `border rgba(255,255,255,0.45)`, `glow-border-hover`, `text-shadow glow-text-strong`
- **Фон** — CursorGlow canvas + Particles (стиль "white")

## Подход

1. Создать `ProfileModal.css` — стили в .clinic эстетике (как AuthModal.css + секции из ProfileEdit.css)
2. Переписать `ProfileModal.tsx` — убрать inline Tailwind, подключить CSS-файл, CursorGlow + Particles, секции с glow-бордерами
3. Логика (logout, telegram status) остаётся без изменений

## Структура нового ProfileModal

```
.profile-overlay          — fixed overlay, bg-black/60, backdrop
  CursorGlow
  Particles(style="white")
  .profile-modal          — карточка (как .auth-card)
    .profile-header       — avatar + имя + кнопка закрыть
      .profile-avatar     — круг с первой буквой, glow border
      .profile-name       — имя пользователя, glow text
      .profile-close      — кнопка ✕
    .profile-section      — секция «Аккаунт»
      .section-icon       — иконка
      .section-header h2  — заголовок секции
      .profile-field      — поля: логин, telegram
        label (uppercase) + span (значение)
        telegram: badge «привязан» / «не привязан»
    .profile-section      — секция «Действия»
      logout button       — glow стиль, red-тинт для logout
```

## Пошаговый план

### Шаг 1: Создать ProfileModal.css

Файл: `client/src/components/auth/ProfileModal.css`

Стили:
- `.profile-overlay` — fixed overlay, курсор none (для CursorGlow), z-50
- `.profile-modal` — карточка: `bg-card`, `border rgba(255,255,255,0.08)`, `radius-xl`, `shadow-card + glow-border`, max-width 420px, `auth-fade-in-up` анимация
- `.profile-header` — flex, avatar + info, border-bottom
- `.profile-avatar` — 56x56 круг, `border rgba(255,255,255,0.15)`, `glow-border`, буква внутри
- `.profile-name` — 1.2rem, font-weight 600, `glow-text`
- `.profile-close` — прозрачная кнопка, `rgba(255,255,255,0.3)`, hover → white
- `.profile-section` — как `.section` из .clinic: `bg-card`, `border rgba(255,255,255,0.06)`, `radius-lg`, hover glow
- `.section-header` — flex, gap, `section-icon` 28x28, h2 uppercase
- `.profile-field` — label uppercase 0.72rem + значение
- `.profile-badge` — inline badge: зелёный (привязан) / красный (не привязан), rgba фон, glow
- `.profile-logout-btn` — как `.auth-btn` но с red-тином, `border rgba(239,68,68,0.3)`, hover → `rgba(239,68,68,0.5)`

### Шаг 2: Переписать ProfileModal.tsx

Файл: `client/src/components/auth/ProfileModal.tsx`

Изменения:
- Убрать все inline Tailwind классы
- Импортировать `ProfileModal.css`
- Импортировать `CursorGlow` и `Particles`
- JSX структура → CSS-классы из ProfileModal.css
- Avatar: первая буква username в круге (как .clinic avatar-placeholder)
- Telegram: uppercase лейбл + badge (зелёный/красный) вместо inline `text-green-400`/`text-red-400`
- Logout: glow-кнопка с red-тином
- Закрытие: клик по overlay + кнопка ✕

### Шаг 3: Проверка

- `npx tsc -b` — 0 ошибок
- `npx vite build` — успешная сборка
- Визуальная проверка (dev-сервер)

## Файлы

| Файл | Действие |
|------|----------|
| `client/src/components/auth/ProfileModal.css` | **Создать** — стили .clinic |
| `client/src/components/auth/ProfileModal.tsx` | **Переписать** — убрать Tailwind, CSS-классы |
| `client/src/index.css` | Не трогать — CSS vars уже есть |
| `client/src/components/effects/CursorGlow.tsx` | Не трогать — уже существует |
| `client/src/components/effects/Particles.tsx` | Не трогать — уже существует |
| `client/src/App.tsx` | Не трогать — ProfileModal уже подключён |
| `client/src/store/index.ts` | Не трогать — интерфейс не меняется |
| `client/src/components/layout/TopBar.tsx` | Не трогать — кнопка «Личный кабинет» уже работает |

## Риски и вопросы

1. **Overlay поверх Chart** — ProfileModal уже overlay, но CursorGlow canvas может мешать кликам по backdrop. Решение: `pointer-events: none` на canvas, как в AuthModal
2. **Размер модала** — ProfileModal сейчас `max-w-sm` (~384px). Оставить ~420px для секций с отступами
3. **Данные** — сейчас только `username` и `telegramVerified`. Если в будущем появятся новые поля (email, роль) — секции легко расширить
4. **Анимация выхода** — пока не планируется (как в AuthModal), только вход через `auth-fade-in-up`
