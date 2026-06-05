# План: Привязка мини-графиков к позициям + автопересортировка 10 сек

## Цель
1. Каждый из 9 мини-графиков привязан к позиции в отсортированном списке (1-й тикер → левый верхний, 2-й → следующий, и т.д.)
2. Автопересортировка раз в 10 секунд вместо 3

## Контекст проблемы

**Текущая бага**: `topChartSymbols` в store приходит в правильном порядке (по объёму), но React reconciliation с `key={tf:symbol}` не перемещает DOM-узлы — он обновляет props на старых позициях. Изменение key на `tf:idx:symbol` не помогло, потому что `topSymbols` в ChartGrid уже приходит в алфавитном порядке.

**Корневая причина**: `useCoinListStore(s => s.topChartSymbols)` — zustand selector возвращает ссылку на массив. Когда `recompute` вызывается из `tickCountdown`, он создаёт новый массив, но React может не заметить изменения, если zustand shallow-equal решит что массив не изменился. Либо `init()` перезаписывает `topChartSymbols` через quick-price-refresh path (строки 211-232), который **НЕ** вызывает `recompute` и не обновляет `topChartSymbols`.

**Упрощение**: Убрать `topChartSymbols` как отдельное поле store. ChartGrid будет читать `sortedCoins` напрямую и брать первые 9 элементов.

## План

### Шаг 1: Убрать `topChartSymbols` из store, вычислять на лету в ChartGrid

**Файл**: `client/src/store/index.ts`

- Удалить `topChartSymbols` из интерфейса `CoinListStore` (строка ~47)
- Удалить `topChartSymbols` из `recompute()` return (строка 79)
- Удалить `topChartSymbols: []` из начального состояния (строка 122)
- Перепроверить все вызовы `recompute()` — они не должны ссылаться на `topChartSymbols`

**Файл**: `client/src/components/charts/ChartGrid.tsx`

- Заменить:
  ```tsx
  const topSymbols = useCoinListStore(s => s.topChartSymbols)
  ```
  На:
  ```tsx
  const sortedCoins = useCoinListStore(s => s.sortedCoins)
  const pageIndex = useCoinListStore(s => s.pageIndex)
  const topSymbols = sortedCoins.slice(pageIndex * 9, pageIndex * 9 + 9).map(c => c.symbol)
  ```
  
  Так ChartGrid берёт символы прямо из `sortedCoins` — порядок гарантированно совпадает со списком тикеров.

### Шаг 2: Изменить интервал автопересортировки с 3 сек на 10 сек

**Файл**: `client/src/store/index.ts`

- Изменить `const SORT_INTERVAL = 3000` → `const SORT_INTERVAL = 10000` (строка 177)
- Изменить countdown с 3→0 на 10→0:
  - Начальное `countdown: 3` → `countdown: 10` (строка 132)
  - В `tickCountdown()`: `set({ countdown: 3 })` → `set({ countdown: 10 })` (строка 144)
  - В `toggleAutoRefresh()`: `countdown: !s.autoRefresh ? 3 : 0` → `countdown: !s.autoRefresh ? 10 : 0` (строка 136)

### Шаг 3: Упростить ключ MiniChart — position-based

**Файл**: `client/src/components/charts/ChartGrid.tsx`

- Key уже `tf:idx:symbol` — оставить. Это заставляет React ставить каждый символ на свою позицию.
- Если символ на позиции 0 меняется (например BTC→ETH после пересортировки), React уничтожит старый MiniChart и создаст новый — график перезагрузится. Это ожидаемое поведение.

### Шаг 4: Обновить loadedSet — использовать позицию вместо символа

**Файл**: `client/src/components/charts/ChartGrid.tsx`

- `loadedSet` сейчас использует `${tf}:${symbol}` как ключ — нормально, потому что один и тот же символ на любой позиции использует одни и те же данные.
- Но overlay check `topSymbols.every(symbol => loadedSet.has(...))` тоже нормален.
- Оставить как есть.

### Шаг 5: Сборка, проверка, коммит

- `cd client && npx tsc --noEmit` — 0 ошибок
- `git add -A && git commit -m "fix: bind mini-charts to sorted position + 10s auto-refresh interval"`
- `git push origin master`
- Перестройка на VPS: `cd /opt/crypto-screener && git pull && docker compose build client && docker compose up -d client`

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `client/src/store/index.ts` | Удалить `topChartSymbols` из интерфейса, recompute, начального состояния; SORT_INTERVAL 3000→10000; countdown 3→10 |
| `client/src/components/charts/ChartGrid.tsx` | Заменить `topChartSymbols` на `sortedCoins.slice(pageIndex*9, pageIndex*9+9).map(c=>c.symbol)` |

## Риски

1. **Графики перезагружаются при пересортировке** — если BTC и ETH поменялись местами, оба графика перезагрузятся (новые key). Это компромисс за правильный порядок. Альтернатива — CSS `order`, но она уже не сработала.

2. **Zustand re-render** — `useCoinListStore(s => s.sortedCoins)` может рендерить ChartGrid чаще, чем `s.topChartSymbols`, потому что `sortedCoins` обновляется при каждом quick-price-refresh. Решение: использовать shallow equality или `useShallow` из zustand:
   ```tsx
   import { useShallow } from 'zustand/react/shallow'
   const { sortedCoins, pageIndex } = useCoinListStore(useShallow(s => ({ sortedCoins: s.sortedCoins, pageIndex: s.pageIndex })))
   ```
   Но даже без оптимизации — ChartGrid и так рендерится при изменении `topChartSymbols`, разница минимальна.

## Открытые вопросы

- Нет. Подход простой и детерминированный: ChartGrid читает тот же `sortedCoins`, что и CoinList.
