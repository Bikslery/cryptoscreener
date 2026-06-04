# План: Редизайн страницы входа/регистрации crypto-screener в стиле .clinic

## Цель

Полностью переработать дизайн `AuthModal` (вход + регистрация) в crypto-screener, приведя его к эстетике проекта `.clinic` — минималистичный тёмный дизайн с glow-эффектами, частицами, свечением курсора, без стандартного синего/blue-500 акцента.

## Контекст

### Текущий AuthModal (crypto-screener)
- Файл: `client/src/components/auth/AuthModal.tsx` (~241 строка)
- Tailwind-классы напрямую в JSX (bg-zinc-900, border-zinc-700, bg-blue-600, text-blue-400 и т.д.)
- Простая центрированная карточка на `bg-[#0a0a0a]` фоне
- Табы «Вход / Регистрация» с `border-blue-500` подчёркиванием
- Инпуты: `bg-zinc-800 border-zinc-600 focus:border-blue-500`
- Кнопка: `bg-blue-600 hover:bg-blue-500`
- Три шага: form → telegram → success
- Tailwind CSS, шрифт JetBrains Mono (моноширинный)

### Референс: .clinic — страница входа (`Admin.jsx` + `Login.css`)
- Файлы: `client/src/pages/Admin.jsx`, `client/src/styles/Login.css`
- **Ключевые дизайн-паттерны:**
  - Фон: `var(--bg-primary)` (#0a0a0a) + два радиальных glow-пятна (::before / ::after псевдоэлементы)
  - Карточка: `var(--bg-card)` (#0f0f0f), `border: 1px solid rgba(255,255,255,0.08)`, `border-radius: var(--radius-xl)` (20px), `box-shadow: var(--shadow-card), var(--shadow-glow)`
  - Hover карточки: `border-color: rgba(255,255,255,0.15)`, `box-shadow: var(--glow-border-hover)`
  - Лейблы: `uppercase`, `letter-spacing: 1px`, `color: rgba(255,255,255,0.4)`, `font-size: 0.75rem`
  - Инпуты: `bg: rgba(255,255,255,0.03)`, `border: rgba(255,255,255,0.08)`, `focus: border rgba(255,255,255,0.4) + box-shadow glow`
  - Placeholder: `rgba(255,255,255,0.2)` с префиксом `$` (стиль терминала)
  - Кнопка: прозрачная, `border: rgba(255,255,255,0.25)`, glow-тень при hover, `text-shadow: var(--glow-text-strong)`
  - Ошибка: `bg: rgba(239,68,68,0.06)`, `border: rgba(239,68,68,0.2)`, glow-свечение
  - Заголовок: `text-shadow: var(--glow-text)`, подзаголовок серый
  - Логотип/иконка: квадрат с границей glow
  - **Accent = белый** (не синий/фиолетовый)
  - Дизайн-система через CSS-переменные (`:root` в `App.css`)

### Референс: .clinic — профиль (дополнительные визуальные элементы)
- **CursorGlow**: canvas с точкой-курсором и шлейфом из 16 точек, свечение
- **Particles**: canvas с частицами (white/rain/snow/matrix стили), реагируют на мышь
- Аватар placeholder: `linear-gradient(135deg, #6c8aff, #a855f7)` (фиолетовый градиент)
- Анимации: fadeInUp, welcomePulse, blink

## Предлагаемый подход

Конвертировать AuthModal из inline Tailwind в отдельный CSS-файл + JSX, следуя дизайн-системе .clinic. Адаптировать .clinic CSS-переменные под crypto-screener (добавить недостающие в `index.css`). Добавить CursorGlow и Particles для атмосферности.

## Пошаговый план

### Шаг 1. Добавить CSS-переменные .clinic в `index.css`

**Файл:** `client/src/index.css`

Добавить в `:root` переменные из .clinic `App.css`:
```css
/* .clinic design system vars */
--bg-card: #0f0f0f;
--bg-input: #141414;
--border-subtle: rgba(255, 255, 255, 0.06);
--border-default: rgba(255, 255, 255, 0.1);
--border-focus: rgba(255, 255, 255, 0.5);
--radius-sm: 8px;
--radius-md: 12px;
--radius-lg: 16px;
--radius-xl: 20px;
--shadow-card: 0 4px 24px rgba(0, 0, 0, 0.4);
--shadow-glow: 0 0 20px rgba(255, 255, 255, 0.06);
--transition: 0.2s ease;
--glow-text: 0 0 10px rgba(255, 255, 255, 0.25);
--glow-border: 0 0 15px rgba(255, 255, 255, 0.08);
--glow-border-hover: 0 0 25px rgba(255, 255, 255, 0.15);
--glow-text-strong: 0 0 12px rgba(255, 255, 255, 0.4), 0 0 30px rgba(255, 255, 255, 0.1);
--accent-glow: rgba(255, 255, 255, 0.12);
```

### Шаг 2. Создать `AuthModal.css`

**Файл:** `client/src/components/auth/AuthModal.css`

Перенести стили из `Login.css` .clinic, адаптировать под crypto-screener:
- `.auth-page` — полноэкранный контейнер с радиальными glow-пятнами (::before / ::after)
- `.auth-card` — карточка с glow-бордером, hover-эффектом
- `.auth-heading`
- `.auth-subtitle` — серый подзаголовок
- `.auth-form` — flex-col с gap
- `.auth-field` — label + input (uppercase label, терминальный стиль)
- `.auth-field label` — uppercase, letter-spacing, rgba(255,255,255,0.4)
- `.auth-field input` — почти прозрачный bg, glow при фокусе
- `.auth-btn` — прозрачная кнопка с белым glow-бордером, hover с text-shadow
- `.auth-error` — красный glow-box
- `.auth-tabs` — табы Вход/Регистрация (стиль: underline с glow, как в .clinic)
- `.auth-divider` — разделитель с линией
- Анимации: fadeInUp для карточки, fadeIn для шагов

### Шаг 3. Переписать `AuthModal.tsx`

**Файл:** `client/src/components/auth/AuthModal.tsx`

Изменения:
1. Заменить все inline Tailwind-классы на CSS-классы из `AuthModal.css`
2. Убрать `bg-blue-600` / `hover:bg-blue-500` / `border-blue-500` / `text-blue-400` → белый accent
3. Лейблы: uppercase с letter-spacing
4. Placeholder инпутов: стиль терминала `$ логин`, `$ пароль`
5. Кнопки: прозрачные с белым glow-бордером
6. Заголовок: `text-shadow: var(--glow-text)`
7. Добавить `<CursorGlow />` и `<Particles style="white" />` как в .clinic (импорт из новых компонентов)
8. Сохранив всю логику (табы, шаги, Telegram polling, валидацию) без изменений
9. Экран Telegram: glow-стилизация кнопки и текста
10. Экран Success: glow-стилизация

### Шаг 4. Создать компонент `CursorGlow`

**Файл:** `client/src/components/effects/CursorGlow.tsx`

Порт из .clinic `CursorGlow.jsx` → TypeScript. Canvas с шлейфом-курсором из 16 точек, свечение. pointer-events: none, z-index: 9999.

### Шаг 5. Создать компонент `Particles`

**Файл:** `client/src/components/effects/Particles.tsx`

Порт из .clinic `Particles.jsx` → TypeScript. Canvas с белыми glow-частицами, реагирующими на мышь. Стили: white (по умолчанию для auth-страницы). pointer-events: none.

## Файлы, которые будут изменены

| Файл | Действие |
|------|----------|
| `client/src/index.css` | Добавить CSS-переменные .clinic |
| `client/src/components/auth/AuthModal.tsx` | Полный редизайн JSX |
| `client/src/components/auth/AuthModal.css` | **Новый** — стили auth-страницы |
| `client/src/components/effects/CursorGlow.tsx` | **Новый** — порт из .clinic |
| `client/src/components/effects/Particles.tsx` | **Новый** — порт из .clinic |

## Тесты / валидация

1. `npm run build` в `client/` — без ошибок
2. Визуальная проверка в браузере:
   - Страница входа: glow-эффекты, частицы, курсор
   - Переключение табов Вход ↔ Регистрация
   - Валидация (ошибки в red glow-стиле)
   - Экран привязки Telegram
   - Экран успеха
   - ProfileModal (если обновляется)
3. Проверить, что логика авторизации работает без изменений (API-вызовы, polling, sessionStorage)

## Риски и компромиссы

1. **Производительность**: CursorGlow + Particles = 2 canvas с requestAnimationFrame. На слабых GPU может тормозить. Mitigation: Particles с меньшим количеством частиц (40 вместо 80).
2. **Совместимость с основным приложением**: Частицы/курсор не должны влиять на основное приложение после входа — они рендерятся только в AuthModal. После входа компоненты размонтируются.
3. **CRLF**: Проект использует CRLF. Использовать Python для find-and-replace или write_file (сохраняет как есть).
4. **Tailwind vs CSS**: Переход от inline Tailwind к отдельному CSS. В crypto-screener Tailwind используется повсеместно, но для auth-страницы чистый CSS даёт точный контроль glow-эффектов, который через Tailwind утилиты громоздок.

## Открытые вопросы

- Нужна ли иконка/логотип в карточке авторизации? В .clinic есть `.login-logo`. Для crypto-screener можно использовать символ (₿, 📈, или стилизованную иконку).
- Добавлять ли Particles на auth-страницу или только CursorGlow? (Предлагаю оба — максимум атмосферности.)
- Обновлять ли ProfileModal в рамках этого плана или отдельно?
