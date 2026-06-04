# План: Копирование дизайна кнопок .clinic → crypto-screener

## Цель
Перенести дизайн кнопок из админ-панели .clinic на главную страницу crypto-screener (TopBar, RightPanel, DrawingToolsPanel, DensityMap, AlertStack, ExpandedChart). Логин и профиль не трогаем — они уже удовлетворяют.

## Контекст

### .clinic — система дизайна кнопок (App.css)
Все кнопки в .clinic используют **одну глобальную систему** без Tailwind — чистые CSS-классы:

| Класс | Описание | Ключевые стили |
|---|---|---|
| `button` (глобальный) | Базовая кнопка | `background: transparent`, `border: 1px solid rgba(255,255,255,0.25)`, `border-radius: var(--radius-sm)`, `text-shadow: var(--glow-text)`, hover: `border-color → 0.5`, `box-shadow: var(--glow-border-hover)`, `text-shadow: var(--glow-text-strong)`, `translateY(-1px)` |
| `:active` | Нажатие | `translateY(0)`, `box-shadow: var(--glow-border)` |
| `:disabled` | Отключена | `opacity: 0.35`, `cursor: not-allowed` |
| `.btn-danger` | Красная | `border-color: rgba(239,68,68,0.4)`, `color: var(--red)`, hover glow red |
| `.btn-secondary` | Серая | `border-color: rgba(255,255,255,0.15)`, `color: var(--text-secondary)`, hover: brighter |
| `.btn-ghost` | Призрачная | `border: transparent`, `color: var(--text-muted)`, hover: `border 0.1`, no translateY |
| `.btn-sm` | Маленькая | `padding: 0.4rem 0.8rem`, `font-size: 0.8rem`, `border-radius: 6px` |

Ключевые визуальные признаки .clinic-кнопок:
- **Прозрачный фон** (нет `bg-[#1a1a1a]`)
- **Glow-свечение при hover** (`--glow-border-hover`)
- **Подъём на 1px при hover** (`translateY(-1px)`)
- **Свечение текста** (`--glow-text-strong`)
- **Скругление** `var(--radius-sm)` = 8px (не 4px)
- **Более тонкая граница** `rgba(255,255,255,0.25)` (не `#2a2a2a`)

### crypto-screener — текущие кнопки (Tailwind inline)
Все кнопки используют **inline Tailwind-классы** с другим визуальным языком:
- Фон `bg-[#1a1a1a]` или `bg-transparent`
- Граница `border-[#2a2a2a]` (тёмная, не полупрозрачная)
- Скругление `rounded-[4px]` (не 8px)
- Нет glow-свечения при hover
- Нет translateY
- Активная вкладка: `bg-[#3a3a3a]` или `bg-white text-black`
- Выбранная биржа: `bg-white text-black border-white` (полная инверсия)

### Уже общее между проектами
crypto-screener уже импортировал CSS-переменные .clinic в `index.css`:
```
--glow-text, --glow-border, --glow-border-hover, --glow-text-strong
--radius-sm/md/lg/xl
--shadow-card, --shadow-glow
--bg-card, --bg-input
--border-subtle/default/focus
--transition: 0.2s ease
```

## Предлагаемый подход

Вместо переноса CSS-классов из .clinic (которая на чистом CSS), **создать аналогичный набор утилитарных CSS-классов в index.css** crypto-screener, затем заменить inline Tailwind на эти классы во всех кнопках главной страницы. Это:
- Сохраняет Tailwind для layout/spacings
- Даёт .clinic-эстетику именно кнопкам
- Не ломает AuthModal/ProfileModal (у них уже свой .clinic CSS)

## Пошаговый план

### Шаг 1. Добавить .clinic-стили кнопок в `client/src/index.css`

Добавить после существующих CSS-переменных:

```css
/* ── .clinic button system ── */
.clinic-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  cursor: pointer;
  font-weight: 500;
  text-shadow: var(--glow-text);
  transition: all var(--transition);
}
.clinic-btn:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.5);
  box-shadow: var(--glow-border-hover);
  text-shadow: var(--glow-text-strong);
  transform: translateY(-1px);
}
.clinic-btn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--glow-border);
}
.clinic-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Small */
.clinic-btn-sm {
  padding: 0.4rem 0.8rem;
  font-size: 0.8rem;
  border-radius: 6px;
}

/* Danger */
.clinic-btn-danger {
  border-color: rgba(239, 68, 68, 0.4);
  color: var(--color-down);
  text-shadow: 0 0 8px rgba(239, 68, 68, 0.3);
}
.clinic-btn-danger:hover:not(:disabled) {
  border-color: rgba(239, 68, 68, 0.7);
  box-shadow: 0 0 20px rgba(239, 68, 68, 0.2);
  text-shadow: 0 0 12px rgba(239, 68, 68, 0.5);
}

/* Secondary */
.clinic-btn-secondary {
  border-color: rgba(255, 255, 255, 0.15);
  color: var(--text-muted);
  text-shadow: none;
}
.clinic-btn-secondary:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.3);
  color: var(--text-primary);
  box-shadow: var(--glow-border);
  text-shadow: var(--glow-text);
}

/* Ghost */
.clinic-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
  text-shadow: none;
}
.clinic-btn-ghost:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.1);
  text-shadow: var(--glow-text);
  box-shadow: none;
  transform: none;
}

/* Active/selected (для таймфреймов, бирж) */
.clinic-btn-active {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.4);
  color: var(--text-primary);
  text-shadow: var(--glow-text-strong);
  box-shadow: var(--glow-border);
}
```

### Шаг 2. Обновить `TopBar.tsx`

**Таймфреймы** — заменить inline Tailwind на `.clinic-btn` + `.clinic-btn-active`:
- Контейнер: убрать `border border-[#2a2a2a] rounded-[4px] bg-[#1a1a1a]`, заменить на `border border-[rgba(255,255,255,0.06)] rounded-[8px] bg-[rgba(255,255,255,0.02)]`
- Каждый TF-баттон: `.clinic-btn .clinic-btn-sm` (неактивный), `.clinic-btn .clinic-btn-sm .clinic-btn-active` (активный)
- Убрать `bg-[#3a3a3a]` у активного, заменить на `.clinic-btn-active`

**Пагинация** (ChevronFirst/Left/Right):
- Заменить inline на `.clinic-btn .clinic-btn-sm` + disabled стили

**Фильтры бирж**:
- Неактивный: `.clinic-btn .clinic-btn-secondary .clinic-btn-sm`
- Активный: `.clinic-btn .clinic-btn-active .clinic-btn-sm`
- Убрать `bg-white text-black border-white`

**Профиль/Вход**:
- `.clinic-btn .clinic-btn-ghost`

### Шаг 3. Обновить `RightPanel.tsx` (табы)

**Табы** (Графики / Плотности / Уведомления):
- Неактивный: `.clinic-btn .clinic-btn-ghost` стиль
- Активный: `text-white border-b-2 border-white` → заменить на `.clinic-btn-active` + `border-b-2 border-[rgba(255,255,255,0.5)]`

### Шаг 4. Обновить `DrawingToolsPanel.tsx`

- Контейнер: `bg-[#222] border-[#383838]` → `bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.08)]` + `border-radius: var(--radius-sm)`
- Инструмент неактивный: `.clinic-btn` без фона
- Инструмент активный: `.clinic-btn .clinic-btn-active`
- Delete: `.clinic-btn .clinic-btn-danger .clinic-btn-sm`

### Шаг 5. Обновить `DensityMap.tsx`

**Переключатели порога** (1% / 2%):
- Неактивный: `.clinic-btn .clinic-btn-secondary .clinic-btn-sm`
- Активный: `.clinic-btn .clinic-btn-active .clinic-btn-sm`
- Убрать `bg-white text-black border-white`

### Шаг 6. Обновить `AlertStack.tsx`

**Кнопка «Новый»**:
- `.clinic-btn .clinic-btn-sm` (стиль как `.login-btn` из .clinic)

**Тип алерта (Цена/Импульс)**:
- Неактивный: `.clinic-btn .clinic-btn-ghost .clinic-btn-sm`
- Активный: `.clinic-btn .clinic-btn-active .clinic-btn-sm`

**Кнопка «Создать»**:
- `.clinic-btn .clinic-btn-sm` (основная светлая)

**Кнопка «Отмена»**:
- `.clinic-btn .clinic-btn-ghost .clinic-btn-sm`

**Mute/Delete**:
- Mute: `.clinic-btn .clinic-btn-ghost`
- Delete: `.clinic-btn .clinic-btn-danger`

### Шаг 7. Обновить `ChartGrid.tsx` (ExpandedChart — кнопка «Назад»)

- Кнопка ← : `.clinic-btn .clinic-btn-sm`
- Убрать `bg-[#1a1a1a] border-[#2a2a2a]`, заменить на прозрачный фон + `.clinic-btn` glow

### Шаг 8. Уточнение размера шрифта/отступов

Для маленьких кнопок в плотном UI (TopBar, DensityMap) — использовать `.clinic-btn-sm`.
Для основных действий (создать, войти) — базовый `.clinic-btn`.

## Файлы для изменения

| Файл | Изменение |
|---|---|
| `client/src/index.css` | Добавить ~80 строк CSS-классов кнопок |
| `client/src/components/layout/TopBar.tsx` | Замена inline стилей → .clinic-btn* классы |
| `client/src/components/layout/RightPanel.tsx` | Замена стилей табов |
| `client/src/components/charts/DrawingToolsPanel.tsx` | Замена стилей кнопок-инструментов |
| `client/src/components/density/DensityMap.tsx` | Замена стилей переключателей |
| `client/src/components/alerts/AlertStack.tsx` | Замена стилей кнопок |
| `client/src/components/charts/ChartGrid.tsx` | Кнопка «Назад» в ExpandedChart |

**НЕ трогаем:**
- `AuthModal.tsx` / `AuthModal.css` — уже .clinic-стиль
- `ProfileModal.tsx` / `ProfileModal.css` — устраивает

## Верификация

1. `npm run dev` — запустить клиент
2. Проверить каждую группу кнопок:
   - TopBar: TF-переключатели, пагинация, биржи, профиль — hover glow, translateY, скругление 8px
   - RightPanel: табы — активное свечение
   - DrawingToolsPanel: инструменты, delete — glow при hover, красный glow у danger
   - DensityMap: пороги — свечение при hover/active
   - AlertStack: новый, создать, отмена, mute, delete — стили .clinic
   - ExpandedChart: кнопка ← — glow
3. Проверить disabled-состояния (первая/последняя страница пагинации)
4. Проверить `font-weight: 200 !important` в глобальном CSS не перебивает `font-weight: 600` у кнопок → может потребоваться `!important` в `.clinic-btn`

## Риски и открытые вопросы

1. **font-weight конфликт** — **РЕШЕНО**: добавить `!important` к `.clinic-btn { font-weight: 600 !important }`.
2. **Плотность UI** — .clinic-кнопки чуть больше по padding (0.6rem 1.2rem базовые) vs текущие (px-[9px] h-[30px]). Для TopBar нужно аккуратно подогнать размеры, чтобы всё влезло в 48px высоту.
3. **Активный TF-стиль** — в .clinic нет «selected tab in group» паттерна. Придётся синтезировать из `.clinic-btn-active`. Может понадобиться тонкая настройка, чтобы отличие активного от hover было очевидным.
4. **Активный биржа-фильтр** — **РЕШЕНО**: оставить инверсию `bg-white text-black`, но добавить glow-свечение (`box-shadow: var(--glow-border-hover)`). Не переключать на `.clinic-btn-active`.
5. **Нет коммитов** — пользователь явно просил не делать git commit/push.

## Важное уточнение от пользователя
- **НЕ** `()`, `$` символы в UI тексте — чистый текст: `войти` не `войти()`, `логин` не `$ логин`
- **НЕ** делать коммиты и не пушить
