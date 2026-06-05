# Plan: Убрать мигание зелёного/красного в шапке графиков

## Goal
Удалить flash-эффекты (мигание фона и рамки) при изменении цены в хедерах ChartGrid — оставить статичные цвета по `change24h`.

## Context
В ChartGrid.tsx есть **3 источника мигания**:

1. **Хедер мини-чарта (стр. 690–709)** — `useState<'green'|'red'|null>(null)` при каждом `livePrice` изменении: фон шапки мигает `bg-[#26a65b]/20` / `bg-[#e74c3c]/20` на 300ms
2. **Хедер полного чарта (стр. 690 аналог, ~стр. 937)** — аналогичный flash по `livePrice`
3. **Рамка чарта (`useFlashEffect`, стр. 529–558)** — при изменении close последней свечи >0.5% — CSS-анимация `flash-border-up`/`flash-border-down` на бордере всего блока чарта (стр. 851, 1297)
4. **CSS keyframes** (`index.css` стр. 164–182) — `@keyframes flash-border-up/down` + `.flash-border-up/down` классы

## Plan

### Step 1: Убрать flash state из хедера мини-чарта
**File:** `client/src/components/charts/ChartGrid.tsx` (~стр. 690)
- Удалить `const [flash, setFlash] = useState<'green'|'red'|null>(null)`
- Удалить `useEffect` с `livePrice` зависимостью, который ставит flash (стр. 692–700)
- В className хедера (стр. 707–708): убрать flash-условие, оставить статичный `bg-[#141414]`

### Step 2: Убрать flash state из хедера полного чарта
**File:** `client/src/components/charts/ChartGrid.tsx` (~стр. 937 аналог)
- То же самое: удалить flash state, useEffect, условие в className
- Оставить `bg-[#141414]`

### Step 3: Удалить `useFlashEffect` hook и его использование
**File:** `client/src/components/charts/ChartGrid.tsx`
- Удалить функцию `useFlashEffect` (стр. 529–558)
- Удалить вызовы `const flashEffect = useFlashEffect(...)` (стр. 762, 1090)
- Убрать `${flashEffect ? \`flash-border-${flashEffect}\` : ''}` из className блоков (стр. 851, 1297)

### Step 4: Удалить CSS keyframes и классы
**File:** `client/src/index.css`
- Удалить `@keyframes flash-border-up` (стр. 164–168)
- Удалить `@keyframes flash-border-down` (стр. 170–174)
- Удалить `.flash-border-up` (стр. 176–178)
- Удалить `.flash-border-down` (стр. 180–182)
- Удалить комментарий `/* Flash effect for price changes */` (стр. 163)

### Step 5: Убрать неиспользуемый `prevPriceRef` (если остался)
- После удаления flash useEffect проверить, используется ли `prevPriceRef` ещё где-то — если нет, удалить

## Files to change
| File | Action |
|------|--------|
| `client/src/components/charts/ChartGrid.tsx` | Удалить flash state, useEffect, useFlashEffect, flash-классы в JSX |
| `client/src/index.css` | Удалить 4 CSS правила + keyframes |

## Validation
- `cd client && npx tsc --noEmit` — нет TS ошибок
- Визуально: шапка графиков статичная, цвет текста `change24h` остаётся (зелёный/красный), но фон НЕ мигает
- Рамка чарта НЕ мигает при обновлении свечей

## Risks / Tradeoffs
- **Потеря feedback**: пользователь не видит мгновенную реакцию на тик — но именно мигание его раздражает, а `change24h` текст уже цветом показывает направление
- **Альтернатива**: можно заменить мигание на мягкое fade (opacity 0.15→0 за 1s) вместо жёсткого flash — но пользователь просит убрать, не смягчить
