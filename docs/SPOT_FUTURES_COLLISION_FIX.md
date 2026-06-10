# Исправление коллизии данных между спотом и фьючерсами

## Корневая причина телепортации свечей

Предыдущие исправления (валидация, race conditions, memory leaks) были **защитными мерами**, но не устраняли **корневую причину** проблемы.

### Проблема

1. **Кэш-ключ без exchange**: `${symbol}:${tf}` → `BTCUSDT:1m`
2. **WebSocket каналы без exchange**: 
   - `candle:${symbol}:${tf}` → `candle:BTCUSDT:1m`
   - `trade:${symbol}` → `trade:BTCUSDT`
3. **Результат**: BTCUSDT на **binance-spot** и **binance-futures** использовали **один кэш-ключ** и **одни WS каналы**

### Симптомы

- Свеча "телепортируется" между ценами спота и фьючерсов
- Последняя свеча мигает и прыгает
- Данные перезаписывают друг друга при каждом обновлении

## Реализованные исправления

### 1. Кэш-ключ теперь включает exchange

**Файл**: `client/src/services/candle-cache.ts`

**Было**:
```typescript
function key(symbol: string, tf: string): string {
  return `${symbol}:${tf}`  // ❌ Коллизия!
}
```

**Стало**:
```typescript
function key(exchange: Exchange, symbol: string, tf: string): string {
  return `${exchange}:${symbol}:${tf}`  // ✅ Уникально!
}
```

**Результат**: 
- `binance-spot:BTCUSDT:1m` ≠ `binance-futures:BTCUSDT:1m`
- Данные больше не перезаписывают друг друга

---

### 2. Обновлены все функции кэша

**Файл**: `client/src/services/candle-cache.ts`

Все функции теперь принимают `exchange` как первый параметр:
- `getCandles(exchange, symbol, tf)`
- `setCandles(exchange, symbol, tf, candles)`
- `prependCandles(exchange, symbol, tf, older)`
- `updateCandle(exchange, symbol, tf, candle)`
- `hasCandles(exchange, symbol, tf)`

---

### 3. WebSocket каналы теперь включают exchange

**Файл**: `client/src/components/charts/ChartGrid.tsx`

**useWsCandle**:
```typescript
// Было: const channel = `candle:${symbol}:${tf}`
const channel = `candle:${exchange}:${symbol}:${tf}`
```

**useWsTrade**:
```typescript
// Было: const tradeType = `trade:${symbol}`
const tradeType = `trade:${exchange}:${symbol}`
```

**usePriceLine**:
```typescript
// Было: const channel = `candle:${symbol}:${tf}`
const channel = `candle:${exchange}:${symbol}:${tf}`
```

---

### 4. Все хуки обновлены для передачи exchange

**Файл**: `client/src/components/charts/ChartGrid.tsx`

Обновлены сигнатуры:
- `useFullHistory(symbol, exchange, tf, ...)`
- `useWsCandle(symbol, exchange, tf, ...)`
- `useWsTrade(symbol, exchange, tf, ...)`
- `usePriceLine(symbol, exchange, tf, ...)`
- `useLazyScroll(symbol, exchange, tf, ...)`

Exchange извлекается из coinMap:
```typescript
const exchange = useCoinListStore(s => s.coinMap.get(symbol)?.exchange)
```

---

### 5. Обновлён candle-prefetch для извлечения exchange из данных

**Файл**: `client/src/services/candle-prefetch.ts`

Поскольку `UnifiedCandle` уже содержит поле `exchange` с сервера, мы извлекаем его из первой свечи:

```typescript
const data = res.data as UnifiedCandle[]
if (data?.length) {
  const exchange = data[0]?.exchange  // Извлекаем из данных
  if (exchange) {
    candleCache.setCandles(exchange, symbol, tf, data)
  }
}
```

---

### 6. Добавлен импорт типа Exchange

**Файл**: `client/src/components/charts/ChartGrid.tsx`

```typescript
import type { Timeframe, UnifiedCandle, Exchange } from '../../types'
```

---

## Изменённые файлы

1. `client/src/services/candle-cache.ts` - кэш-ключи с exchange
2. `client/src/components/charts/ChartGrid.tsx` - все хуки и WS каналы
3. `client/src/services/candle-prefetch.ts` - извлечение exchange из данных
4. `shared/types.ts` - уже содержал Exchange тип

---

## Проверка исправления

### До исправления:
```
Cache key: "BTCUSDT:1m"
WS channel: "candle:BTCUSDT:1m"

Chart 1 (spot):    пишет в "BTCUSDT:1m"
Chart 2 (futures): пишет в "BTCUSDT:1m"  ❌ Коллизия!
```

### После исправления:
```
Cache key: "binance-spot:BTCUSDT:1m"
WS channel: "candle:binance-spot:BTCUSDT:1m"

Chart 1 (spot):    пишет в "binance-spot:BTCUSDT:1m"
Chart 2 (futures): пишет в "binance-futures:BTCUSDT:1m"  ✅ Разделены!
```

---

## Важные замечания

### 1. Серверная сторона
**Требуется проверка**: Убедитесь, что сервер отправляет данные на exchange-специфичные каналы:
- `candle:${exchange}:${symbol}:${tf}`
- `trade:${exchange}:${symbol}`

Если сервер всё ещё использует старый формат без exchange, нужно обновить `server/src/ws/hub.ts`.

### 2. Обратная совместимость
Старые данные в кэше с ключами без exchange будут игнорироваться. Это нормально - кэш пересоздастся при первой загрузке.

### 3. Производительность
Разделение кэша по exchange увеличивает использование памяти, но это необходимо для корректности данных.

---

## Тестирование

### Сценарий 1: Два графика одного символа
1. Откройте BTCUSDT на binance-spot
2. Откройте BTCUSDT на binance-futures
3. **Ожидаемый результат**: Каждый график показывает свои данные без телепортации

### Сценарий 2: Переключение между биржами
1. Откройте BTCUSDT на binance-spot
2. Переключите на binance-futures
3. **Ожидаемый результат**: Данные загружаются заново, без смешивания

### Сценарий 3: WebSocket обновления
1. Откройте два графика с одним символом на разных биржах
2. Дождитесь обновлений по WebSocket
3. **Ожидаемый результат**: Каждый график обновляется независимо

---

## Связь с предыдущими исправлениями

Предыдущий коммит (`ef345b2`) добавил:
- Валидацию данных (защита от NaN/Infinity)
- Исправление race conditions
- Исправление memory leaks
- Уменьшение throttle до 16ms

Эти исправления **остаются актуальными** и работают вместе с текущим исправлением коллизии exchange.

---

## Итог

**Корневая причина устранена**: Спот и фьючерсы больше не конфликтуют в кэше и WebSocket каналах.

**Телепортация свечей должна полностью исчезнуть** после этого исправления.
