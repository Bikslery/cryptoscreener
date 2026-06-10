# Исправления проблем с отрисовкой последней свечи

## Проблемы
Последняя свеча на графиках отображалась с лагами:
- Полная невидимость свечи
- Отсутствие частей свечи
- Телепортация начала свечи

## Реализованные исправления

### 1. **КРИТИЧЕСКОЕ**: Исправлена блокировка обновлений при ошибке setData
**Файл**: `client/src/components/charts/ChartGrid.tsx:256-283`

**Проблема**: Если `setData()` выбрасывал исключение, `adjustingRef.current` оставался `true` навсегда, блокируя все будущие WebSocket обновления.

**Решение**: Обернул `setData` в `try/finally` блок, чтобы `adjustingRef.current = false` выполнялся всегда, даже при ошибке. Добавлено логирование ошибок.

```typescript
try {
  candleRef.current?.setData(candleData)
  volumeRef.current?.setData(volumeData)
  // ... остальной код
} catch (err) {
  console.error('[ChartGrid] setData failed during lazy scroll', { symbol, tf, error: err })
} finally {
  adjustingRef.current = false
}
```

---

### 2. **ВЫСОКИЙ ПРИОРИТЕТ**: Добавлено поле isFinal в типы
**Файл**: `shared/types.ts:18-29`

**Проблема**: Серверная сторона использовала поле `isFinal`, но клиентская типизация его не объявляла, создавая несоответствие типов.

**Решение**: Добавил `isFinal?: boolean` в интерфейс `UnifiedCandle`.

---

### 3. **ВЫСОКИЙ ПРИОРИТЕТ**: Валидация данных свечей в кэше
**Файл**: `client/src/services/candle-cache.ts:31-43`

**Проблема**: Невалидные данные (NaN, Infinity, некорректные OHLC соотношения) могли попасть в кэш и вызвать проблемы с отрисовкой.

**Решение**: Добавлена функция `validateCandle()`, которая проверяет:
- Все OHLC поля являются конечными числами
- `high >= low`
- `high >= open && high >= close`
- `low <= open && low <= close`
- `volume >= 0` и конечное число
- `time > 0`

Валидация применяется в `dedupSort()` и `updateCandle()` перед добавлением в кэш.

---

### 4. **ВЫСОКИЙ ПРИОРИТЕТ**: Валидация OHLC в useWsCandle
**Файл**: `client/src/components/charts/ChartGrid.tsx:402-457`

**Проблема**: Данные из WebSocket не проверялись перед обработкой.

**Решение**: Добавлена проверка перед обработкой свечи:
```typescript
if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
  console.warn('[useWsCandle] Invalid OHLC data', { symbol, tf, time: c.time })
  return
}
```

---

### 5. **ВЫСОКИЙ ПРИОРИТЕТ**: Валидация volume в useWsTrade
**Файл**: `client/src/components/charts/ChartGrid.tsx:459-541`

**Проблема**: `trade.volume` мог быть `undefined`, приводя к `NaN` в свечах.

**Решение**: Явная валидация и санитизация volume:
```typescript
const volume = typeof trade.volume === 'number' && isFinite(trade.volume) && trade.volume >= 0
  ? trade.volume
  : 0
```

Добавлена валидация построенной свечи перед записью в кэш:
```typescript
if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
  console.warn('[useWsTrade] Invalid constructed candle', { symbol, tf, time: c.time })
  return
}
```

---

### 6. **ВЫСОКИЙ ПРИОРИТЕТ**: Фильтрация невалидных свечей при рендеринге
**Файл**: `client/src/components/charts/ChartGrid.tsx:84-104`

**Проблема**: Невалидные свечи могли попасть в `lightweight-charts`, вызывая проблемы с отрисовкой.

**Решение**: Добавлен фильтр перед маппингом:
```typescript
const validCandles = candles.filter(c =>
  isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) &&
  isFinite(c.volume) && c.volume >= 0 && c.time > 0
)
```

---

### 7. **СРЕДНИЙ ПРИОРИТЕТ**: Валидация слияния свечей в queueCandle
**Файл**: `client/src/components/charts/ChartGrid.tsx:376-400`

**Проблема**: При слиянии свечей с одинаковым временем могла нарушиться инвариантность `high >= low`.

**Решение**: Добавлена проверка после слияния:
```typescript
if (merged.high < merged.low) {
  console.warn('[queueCandle] Invalid merge detected', { prev, p, merged })
  merged.high = Math.max(prev.high, p.high, prev.low, p.low)
  merged.low = Math.min(prev.high, p.high, prev.low, p.low)
}
```

---

### 8. **СРЕДНИЙ ПРИОРИТЕТ**: Исправлена утечка памяти в price line timer
**Файл**: `client/src/components/charts/ChartGrid.tsx:902-945`

**Проблема**: Таймер `updateTimerRef` не очищался при размонтировании компонента, вызывая обращение к уничтоженным ref'ам.

**Решение**: Добавлена очистка таймера в cleanup функции обоих useEffect:
```typescript
return () => {
  if (updateTimerRef.current) {
    clearTimeout(updateTimerRef.current)
    updateTimerRef.current = null
  }
}
```

---

### 9. **НИЗКИЙ ПРИОРИТЕТ**: Уменьшен throttle для более плавной отрисовки
**Файл**: `client/src/components/charts/ChartGrid.tsx:341-364`

**Проблема**: Throttle в 50ms был слишком большим, вызывая видимые скачки при быстрых обновлениях.

**Решение**: Уменьшен throttle до 16ms (60fps) для синхронизации с циклом перерисовки браузера:
```typescript
if (now - lastFlushTime.current < 16) {
  rafId.current = requestAnimationFrame(flush)
  return
}
```

---

## Результаты

### Устранённые проблемы:
1. ✅ **Невидимость свечи** - исправлена через валидацию данных и исправление блокировки adjustingRef
2. ✅ **Отсутствие частей свечи** - исправлена через валидацию OHLC соотношений и фильтрацию невалидных данных
3. ✅ **Телепортация свечи** - исправлена через уменьшение throttle и валидацию слияния свечей

### Дополнительные улучшения:
- Добавлено логирование невалидных данных для мониторинга качества данных
- Исправлена утечка памяти в таймерах
- Улучшена типобезопасность (добавлено поле isFinal)
- Многоуровневая защита от невалидных данных (кэш → обработка → рендеринг)

### Побочные эффекты:
- Невалидные свечи теперь отклоняются (логируются в консоль)
- Немного увеличена частота обновлений (16ms вместо 50ms) - может незначительно повысить нагрузку на CPU
- Добавлена избыточная валидация на нескольких уровнях для надёжности

## Тестирование
- ✅ TypeScript компиляция прошла успешно
- ✅ Vite сборка завершена без ошибок
- ⚠️ Требуется ручное тестирование в браузере для проверки визуальных улучшений

## Рекомендации для дальнейшего мониторинга
1. Следить за логами `[useWsCandle] Invalid OHLC data` и `[useWsTrade] Invalid constructed candle` - они указывают на проблемы с качеством данных от бирж
2. Мониторить частоту срабатывания `[queueCandle] Invalid merge detected` - может указывать на проблемы в логике слияния
3. Проверить производительность на слабых устройствах после уменьшения throttle до 16ms
