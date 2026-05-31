# Plan: Формирующаяся свеча как у ScalpBoard

## Цель
Сделать отрисовку последней (формирующейся) свечи идентичной ScalpBoard — мгновенное обновление при каждом тике, без задержек, без дёрганий.

## Текущее состояние (проблемы)

1. **Код сломан**: предыдущий рефакторинг удалил определения `useDirectUpdate` и `LastBar`, но оставил 8 вызовов/ссылок. `tsc -p tsconfig.app.json --noEmit` даёт 8 ошибок `TS2304: Cannot find name`.
2. **Price line через createPriceLine**: отдельный объект с ручным `applyOptions({ price })` на каждый тик — лишняя работа и потенциальные рывки.
3. **Избыточный indirection**: `useDirectUpdate` → `updateCandle/updateVolume/updatePriceLine` — лишний уровень абстракции; ScalpBoard вызывает `series.update()` напрямую.

## Как ScalpBoard рисует последнюю свечу

### Архитектура (из бандла scalpboard.io/_nuxt/DtedAdVY.js)

```js
// G — mutable ссылка на последнюю свечу (let G)
// d — candlestick series
// a — volume series

// 1. addData (начальная загрузка) — setData()
Ie = (N, oe=[]) => {
  if(!d || !a || g) return
  let me
  n.settings.candlesType === "line"
    ? me = N.map(Te => ({time: Te.time, value: Te.close}))
    : me = N
  d.setData([...me, ...d.data()])
  a.setData([...N.map(Te => ({time: Te.time, value: Te.volume})), ...a.data()])
  f && f.setData([...oe.map(Te => ({time: Te.time, value: Te.value})), ...f.data()])
}

// 2. updateLastKline (kline WS event) — полная свеча от биржи
ie = N => {
  if(!d || !a || g) return
  G = N  // перезаписываем G целиком
  n.settings.candlesType === "line"
    ? d.update({time: N.time, value: N.close})
    : d.update(N)
  a.update({time: N.time, value: N.volume})
}

// 3. updateLastPrice (price WS event) — мутация последней свечи
ge = (N, oe) => {  // N=price, oe=time
  if(!d || g || !G) return
  // Валидация: время должно быть строго ВНУТРИ текущего интервала
  if(!(oe > G.time && oe < G.time + ye[n.settings.interval])) {
    console.log("updateLastPrice not in interval", N, oe)
    return
  }
  n.settings.candlesType === "line"
    ? d.update({time: G.time, value: N})
    : (G.close = N, G.high = Math.max(G.high, N), G.low = Math.min(G.low, N), d.update(G))
}
```

### Ключевые отличия от нашего кода

| Аспект | ScalpBoard | Наш код (текущий) |
|--------|-----------|-------------------|
| `lastBarRef` | `let G` — простая переменная в замыкании | `useRef<LastBar \| null>` — React ref (лишний indirection) |
| series.update() | Прямой вызов `d.update(G)` | Через `useDirectUpdate` → `direct.updateCandle()` |
| Price line | `lastValueVisible: false, priceLineColor: _e("--chart--price")` — встроенная линия серии | Отдельный `createPriceLine()` с ручным обновлением |
| Валидация | `oe > G.time && oe < G.time + interval` — строго внутри | `bar.time + tfSeconds <= candleTime` — другая логика, + нет верхней границы |
| Kline handler | `G = N; d.update(N)` — перезапись G целиком | `lastBarRef.current = {...c}` — создание нового объекта |
| Volume | `a.update({time, value})` — без цвета | `direct.updateVolume({time, value, color: ...})` — с цветом (OK, у нас больше функций) |
| Стили свечей | 3 режима: default/hollow/bars/line | Только один стиль |

## План реализации

### Шаг 1: Восстановить сломанный код — определить `useDirectUpdate` и `LastBar`

**Файл**: `client/src/components/charts/ChartGrid.tsx`

Добавить перед `useWsCandle`:

```ts
type LastBar = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function useDirectUpdate(
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  volumeRef: React.RefObject<ISeriesApi<'Histogram'> | null>,
  priceLineRef: React.RefObject<any>,
  lastCandleTsRef: React.RefObject<number>,
  destroyedRef: React.RefObject<boolean>,
) {
  const updateCandle = useCallback((bar: { time: Time; open: number; high: number; low: number; close: number }) => {
    if (destroyedRef.current) return
    const s = candleRef.current
    if (!s) return
    s.update(bar)
    if (bar.time as number > lastCandleTsRef.current) {
      lastCandleTsRef.current = bar.time as number
    }
  }, [])

  const updateVolume = useCallback((bar: { time: Time; value: number; color?: string }) => {
    if (destroyedRef.current) return
    const s = volumeRef.current
    if (!s) return
    s.update(bar)
  }, [])

  const updatePriceLine = useCallback((price: number, color: string) => {
    if (destroyedRef.current) return
    const pl = priceLineRef.current
    if (!pl) return
    pl.applyOptions({ price, color })
  }, [])

  return { updateCandle, updateVolume, updatePriceLine }
}
```

Это **минимальный ремонт** — вернёт код в рабочее состояние. После этого можно рефакторить дальше.

### Шаг 2: Убрать отдельный priceLine, использовать встроенный `priceLineColor` серии

**Проблема**: Мы создаём отдельный `createPriceLine()` и обновляем его на каждый тик. ScalpBoard использует встроенную цену серии с `lastValueVisible: false` и `priceLineColor`.

**Изменения**:

1. В опциях CandlestickSeries добавить `lastValueVisible: false, priceLineColor: CSS_VAR_FOR_PRICE_LINE`
2. Удалить `createPriceLine()` / `priceLineRef`
3. Удалить `updatePriceLine()` из `useDirectUpdate`
4. `series.update(bar)` автоматически обновит позицию встроенной линии

**Риск**: встроенная линия LWC показывает только `close` — нет кастомного label. Если нужен кастомный label (символ, цена, % изменения) — придётся оставить отдельный priceLine или делать overlay.

**Решение**: сохранить оба варианта — встроенная линия для мгновенного обновления + кастомный label поверх если нужен.

### Шаг 3: Заменить `lastBarRef = useRef` на `let G` в замыкании

**Проблема**: `useRef` создаёт лишний indirection и не позволяет просто мутировать объект.

**Изменения**: вместо `const lastBarRef = useRef<LastBar | null>(null)` — сделать `lastBarRef` простым mutable объектом, доступным из обоих useEffect (useWsCandle, useWsTrade).

Вариант A: `useRef` оставить, но мутировать `.current` напрямую (уже так делаем).
Вариант B: вынести `lastBarRef` в замыкание родительского компонента как `useRef` — уже так.

**Решение**: оставить `useRef` — это React-way, разница минимальна. ScalpBoard не использует React.

### Шаг 4: Исправить валидацию интервала — upper bound

**Текущий код** (useWsTrade, line 641):
```ts
if (!bar || bar.time !== candleTime || (bar.time + tfSeconds <= candleTime))
```

Это неправильно:
- `bar.time !== candleTime` — проверяет что candle bucket совпадает
- `bar.time + tfSeconds <= candleTime` — **всегда false** если `bar.time === candleTime` (т.к. `tfSeconds > 0`)

**ScalpBoard**:
```js
if(!(oe > G.time && oe < G.time + ye[interval])) return
```
Проверяет что `tradeTime` строго между `G.time` (начало свечи) и `G.time + interval` (конец свечи).

**Исправление**:
```ts
// tradeSec = trade timestamp in seconds
// Если trade выходит за верхнюю границу текущей свечи → создать новую
if (!bar || tradeSec >= bar.time + tfSeconds) {
  // Новая свеча
  lastBarRef.current = { time: candleTime, open: price, high: price, low: price, close: price, volume }
} else if (tradeSec < bar.time) {
  // Trade из прошлого — игнорировать
  return
} else {
  // Мутация текущей свечи
  bar.close = price
  if (price > bar.high) bar.high = price
  if (price < bar.low) bar.low = price
  bar.volume += volume
}
```

### Шаг 5: CSS-переменные — синхронизация с ScalpBoard

**ScalpBoard CSS vars**:
- `--chart--candle-up` → заливка up свечи (default) или transparent (hollow)
- `--chart--candle-down` → заливка down свечи
- `--chart--candle-border-up` → border + wick up
- `--chart--candle-border-down` → border + wick down
- `--chart--price` → цвет price line
- `--chart--crosshair` → crosshair
- `--chart--grid` → grid lines
- `--chart--volumes` → volume bars

**Наши CSS vars** (из предыдущего рефакторинга):
- `--chart-candle-up` → разные имена! Нет `--` между chart и candle
- `--chart-candle-down`, `--chart-candle-up-vol`, etc.

**Исправление**: переименовать в `--chart--candle-up` (двойное тире) для совместимости. Добавить `--chart--price`, `--chart--crosshair`, `--chart--grid`.

### Шаг 6: Hollow candles поддержка

ScalpBoard поддерживает hollow candles: `upColor: "transparent"`, `borderUpColor: css-var`.

**Изменения**: добавить `candlesType` setting (default/hollow/bars/line) и соответствующие опции серии. При hollow — `upColor = "transparent"`, `downColor = css-var`, border = css-var.

## Порядок выполнения

1. **Шаг 1** — восстановить сломанный код (useDirectUpdate + LastBar). Без этого ничего не работает.
2. **Шаг 4** — исправить валидацию интервала. Это баг.
3. **Шаг 2** — убрать отдельный priceLine, использовать встроенный. Основное улучшение отзывчивости.
4. **Шаг 5** — синхронизировать CSS-переменные с ScalpBoard naming.
5. **Шаг 3** — оптимизация lastBarRef (низкий приоритет, разница минимальна).
6. **Шаг 6** — hollow candles (косметика, низкий приоритет).

## Файлы

- `client/src/components/charts/ChartGrid.tsx` — основной файл, все изменения здесь
- `client/src/index.css` или глобальный CSS — добавить CSS-variable definitions

## Валидация

1. `npx tsc -p tsconfig.app.json --noEmit` — 0 ошибок
2. Визуальная проверка в браузере: формирующаяся свеча обновляется мгновенно при каждом тике
3. Сравнение side-by-side с ScalpBoard на одной паре/таймфрейме

## Риски

- Удаление `createPriceLine` может сломать кастомный price label если он используется где-то ещё
- Hollow candles — новый функционал, может потребовать UI для переключения
- CSS-var переименование может сломать существующие темы если они уже используют старые имена

## Открытые вопросы

1. Нужен ли кастомный price label (символ + цена + %)? Если да — оставить отдельный priceLine как overlay, но основную линию обновлять через series.update()
2. Поддерживать ли все 4 режима свечей (default/hollow/bars/line) или только default + hollow?
3. Нужно ли добавлять `--chart--volumes` для цвета volume bars? ScalpBoard использует однотонный volume.
