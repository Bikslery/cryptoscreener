# Plan: 3 бага — пустота при скролле, тикеры без трейдов, race свечей

**Дата:** 2026-05-31  
**Статус:** plan-only, no exec

---

## Баг 1: Пустое место при скролле истории до подгрузки свечей

### Корень
`useLazyScroll` (стр. 168–301) начинает загрузку слишком поздно — `threshold = Math.max(100, visibleBars * 0.3)`. К моменту срабатывания юзер уже видит пустоту слева. Запрос `getOrFetchOlder` занимает 400–1500мс, за это время пустота видна. Нет визуальной подсказки. Нет превентивной подгрузки.

### Фикс (3 части, приоритет: 1 > 3 > 2)

#### 1a. Поднять порог префетча (самый дешёвый, закрывает 95% случаев)

**Файл:** `client/src/components/charts/ChartGrid.tsx`  
**Строка:** ~175 (внутрь debounced callback)

```diff
- const threshold = Math.max(100, visibleBars * 0.3)
+ const threshold = Math.max(300, visibleBars * 0.6)
```

Начинать качать когда до края остаётся 60% viewport или минимум 300 баров. Даёт ~600мс форы при типичном скролле.

#### 1b. Префетч следующей страницы сразу после merge

**Файл:** `client/src/components/charts/ChartGrid.tsx`  
**Строка:** ~216–218 (после `emptyCountRef.current = 0`)

```typescript
// Предзагрузка следующей страницы в фон
if (visibleBars > 0 && newCandles.length === 1000) {
  const nextBefore = newCandles[0].time
  getOrFetchOlder(curSymbol, curTf, nextBefore, 1000).then(more => {
    if (more.length && !destroyedRef.current) {
      candleCache.prependCandles(curSymbol, curTf, more)
    }
  }).catch(() => {}) // тихо — это превентивный, не блокирующий
}
```

Условие: если пришли полные 1000 свечей — значит история ещё есть, грузи дальше. Не блокирует UI — фоновая запись в кэш. Следующий `onRange` найдёт данные в кэше мгновенно.

#### 1c. Запретить скролл за край кэша во время инфлайта

**Файл:** `client/src/components/charts/ChartGrid.tsx`  
**Строка:** ~171 (в начало debounced callback, ПЕРЕД threshold check)

```typescript
// Clamp: не давать скроллить в пустоту пока история едет
if (inflightRef.current && range.from < 0) {
  adjustingRef.current = true
  ts?.setVisibleLogicalRange({ from: 0, to: range.to - range.from })
  adjustingRef.current = false
  return
}
```

График «упрётся» в крайнюю свечу. Дыра не появится.

**Предосторожность:** нужен `ts` (timeScale) внутри debounced callback. Сейчас `ts` получается позже (стр. 227). Решение: взять `chartRef` в ref (уже есть) и вызвать `chartRef.current?.timeScale()` в начале.

---

## Баг 2: Тикеры не обновляют цену с трейдами в реалтайме

### Корень (пересмотренный после инспекции кода)

**Клиентский стор УЖЕ подписан на `trade:*` через wildcard** (`store/index.ts` стр. 198–206), вызывает `setLivePrice(trade.symbol, p)`. `useLivePrice(symbol)` работает в ExpandedChart (стр. 718: `livePrice ?? coin?.price ?? 0`).

Реальная проблема — **двойная:**

1. **Fallback на `coin?.price`**: если `useLivePrice` возвращает `undefined` (WS reconnect, подписка ещё не восстановлена, или символ не попал в wildcard-фильтр) — fallback на `coin?.price` из ticker-батча. Ticker батчится каждые 200мс + delta-фильтр. Если для символа не изменились price/change24h/volume — сервер НЕ шлёт ticker-апдейт (aggregator стр. 148: `if (delta.length > 0) broadcast(...)`). При WS reconnect символ может пропустить первый snapshot и не попасть в `lastBroadcastedTickers` — delta пуст, тикер не шлётся пока цена не изменится от адаптера.

2. **Мини-чарты** (стр. 643): используют `useWsCandle` но **НЕ** `useWsTrade`. Цена в мини-чартах обновляется только через `useLivePrice` (wildcard) или `coin?.price` (ticker батч). Если wildcard-подписка лагает — цена замирает.

### Фикс (2 части)

#### 2a. useWsTrade должен вызывать setLivePrice (для ExpandedChart)

**Файл:** `client/src/components/charts/ChartGrid.tsx`  
**Строка:** ~439 (после `candleCache.updateCandle`)

```typescript
import { setLivePrice } from '../../store'  // новый экспорт
```

Внутри обработчика `useWsTrade`:
```typescript
// Обновляем live price — трейд самый свежий источник
setLivePrice(symbol, price)
```

5 строк. Закрывает «график бежит, цена в хедере стоит» — если `useLivePrice` по какой-то причине lag, трейд всё равно пушит.

#### 2b. Экспортировать setLivePrice из store

**Файл:** `client/src/store/index.ts`

```diff
- function setLivePrice(symbol: string, price: number) {
+ export function setLivePrice(symbol: string, price: number) {
```

Строка 107: убрать `function` → `export function`.

**Серверный fast-path (предложен юзером, пункт 2)**: форвардить aggTrade-цену в ticker:SYMBOL минуя 200мс батч. Это серверное изменение — `server/src/services/aggregator/index.ts` + `server/src/services/trades/aggTrade.ts`. **Не делаем в этом плане** — это архитектурное улучшение, не фикс бага. Клиентский фикс 2a достаточен.

---

## Баг 3: Пустое место во время формирования свечи — race useWsTrade vs useWsCandle

### Корень

Два независимых писателя в одну series без координации:

1. `useWsTrade` (стр. 449): `flush.queueCandle({ time: candleTime, ... })` — локально-агрегированная свеча
2. `useWsCandle` (стр. 378): `flush.queueCandle({ time: c.time, ... })` — серверная свеча

`queueCandle` (стр. 341–343) просто перезаписывает `pendingCandle.current = p` — без проверки времени. Если серверная свеча T-1 приходит после локальной T — `pendingCandle` перезаписывается на T-1. `flush()` вызывает `series.update(T-1)`. Lightweight-charts молча убирает свечу T из viewport → дыра.

Дополнительно: `useWsCandle` не проверяет `c.time < lastTime` в backing array — может вставить устаревшую свечу.

### Фикс (3 части, приоритет: 3 > 2 > 1)

#### 3a. useWsCandle: игнорировать серверные свечи старше последней в series (САМЫЙ ВАЖНЫЙ)

**Файл:** `client/src/components/charts/ChartGrid.tsx`  
**Строка:** ~366 (после `const c = msg.data as UnifiedCandle`, перед `candleCache.updateCandle`)

```typescript
// Отвергаем устаревшие серверные свечи — закрытие старого периода
// Обновляем кэш (для истории), но НЕ рисуем
if (candlesDataRef?.current) {
  const lastTime = candlesDataRef.current[candlesDataRef.current.length - 1]?.time
  if (lastTime && c.time < lastTime) {
    candleCache.updateCandle(symbol, tf, c) // кэш — ок, для истории
    return // но НЕ в series — убьёт текущую свечу
  }
}
```

#### 3b. queueCandle: отвергать out-of-order

**Файл:** `client/src/components/charts/ChartGrid.tsx`  
**Строка:** ~341 (внутрь `queueCandle`)

```diff
  queueCandle(p: { time: Time; open: number; high: number; low: number; close: number }) {
+   const prev = pendingCandle.current
+   // Не давать старой свече затирать новую
+   if (prev && p.time < prev.time) return
    pendingCandle.current = p
    schedule()
  },
```

#### 3c. useWsTrade: писать полную UnifiedCandle в candleCache (уже частично сделано)

**Файл:** `client/src/components/charts/ChartGrid.tsx`  
**Строка:** ~439

Сейчас пишет `curRef.current` который `{ time, open, high, low, close, volume }` — без `symbol, exchange, timeframe`. `candleCache.updateCandle` ожидает `UnifiedCandle`. Посмотреть что именно нужно:

```typescript
// Сейчас (стр. 439):
candleCache.updateCandle(symbol, tf, c)
// c = curRef.current = { time, open, high, low, close, volume }
// Нужен полный UnifiedCandle:
const synthCandle: UnifiedCandle = {
  symbol, exchange: 'binance', timeframe: tf,
  time: c.time, open: c.open, high: c.high,
  low: c.low, close: c.close, volume: c.volume,
}
candleCache.updateCandle(symbol, tf, synthCandle)
```

**Проверить:** нужен ли `exchange` в `UnifiedCandle` для `updateCandle`. Посмотреть тип `UnifiedCandle` в `types.ts`.

---

## Файлы

| Файл | Изменения |
|------|-----------|
| `client/src/components/charts/ChartGrid.tsx` | Баг 1 (1a, 1b, 1c), Баг 2 (2a), Баг 3 (3a, 3b, 3c) |
| `client/src/store/index.ts` | Баг 2 (2b): export `setLivePrice` |

## Порядок реализации

1. **Баг 3a** — useWsCandle out-of-order guard (самый важный фикс)
2. **Баг 3b** — queueCandle out-of-order guard (защита в глубину)
3. **Баг 1a** — threshold 0.6 / 300 (самый дешёвый, закрывает 95% пустоты)
4. **Баг 2b** — export setLivePrice из store
5. **Баг 2a** — useWsTrade вызывает setLivePrice
6. **Баг 3c** — полный UnifiedCandle в candleCache из useWsTrade
7. **Баг 1c** — clamp visible range при inflight
8. **Баг 1b** — префетч следующей страницы

## Валидация

1. `npx tsc --noEmit` — без ошибок
2. Ручное тестирование:
   - Скролл влево: пустота не появляется, загрузка начинается раньше
   - Быстрый скролл: при inflight график «упирается» в край
   - Раскрытый чарт: цена в хедере = цена последнего трейда (не отстаёт от свечи)
   - Формирование 5m свечи: нет «провалов» при одновременных trade + candle сообщениях

## Риски / открытые вопросы

- **1c (clamp):** `ts?.setVisibleLogicalRange` внутри debounced callback — нужно убедиться что `chartRef.current` доступен. Debounce callback читает `chartRef` через ref — ок, ref стабильный.
- **1b (префетч):** Фоновый `getOrFetchOlder` без `setData` — данные пишутся только в кэш. Следующий `onRange` найдёт их через `candleCache.getCandles`. НО `candlesDataRef.current` не обновляется префетчем — только при следующем `setData`. Это нормально — `onRange` прочитает кэш и сделает merge.
- **2a (setLivePrice):** `useWsTrade` подписан на конкретный `trade:SYMBOL`. Wildcard в сторе тоже подписан. Будет дублирование `setLivePrice` вызовов для ExpandedChart — но `setLivePrice` имеет идемпотентную проверку `if (prev === price) return` (стр. 109). Безопасно.
- **3a (lastTime check):** Нужен `candlesDataRef` — в ExpandedChart передаётся, в мини-чартах НЕТ (стр. 643: `useWsCandle(symbol, tf, flush, destroyedRef)` без candlesDataRef). Мини-чарты не используют `useWsTrade`, race только в ExpandedChart. Проверка `candlesDataRef?` (optional) — ок.
- **3c (UnifiedCandle):** Нужно проверить обязательные поля `UnifiedCandle` в типах. Если `exchange` обязателен — хардкод `'binance'` может быть неверным для Bybit/OKX. Лучше читать из trade-данных или из `coinMap`.
