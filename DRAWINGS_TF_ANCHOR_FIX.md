# Исправление привязки рисунков к таймфрейму

## Проблема
При смене таймфрейма (например, с 1m на 1h) нарисованные на графике объекты (h-ray, t-ray, segment) сдвигались, а вторая точка "телепортировалась" в случайное место.

## Корневая причина
В `primitive.ts` функция `timeToPixel` использовала линейную интерполяцию по видимому диапазону как fallback, когда `timeToCoordinate` возвращал `null`. Это давало неверный пиксель, потому что:

1. **`timeToCoordinate` требует точного совпадения времени с баром.** При клике на 1m-ТФ в 14:23:15 сохранялось `time = 14:23:00` (начало минуты). При переключении на 1h это уже не время 1h-бара, и LWC возвращает `null`.
2. **Линейная интерполяция между `from` и `to` видимого диапазона не учитывала реальное расположение баров.** На ТФ ≥ 1h `getVisibleRange()` возвращал `BusinessDay` объекты, которые приводились к `number` через `as number`, давая NaN-подобные значения и "телепорт" второй точки.

## Исправления

### 1. Бинарный поиск бара по времени — `findBarByTime`
Добавлена экспортированная функция в `primitive.ts`:

```typescript
export function findBarByTime(
  candleData: ReadonlyArray<UnifiedCandle>,
  targetTime: number,
): number | null {
  // ...бинарный поиск, O(log n)...
  // Возвращает индекс бара с time <= targetTime (rightmost match)
  // или null если targetTime раньше первого бара
}
```

**Логика**: для подбарного времени (например 14:23 на 1h) возвращается индекс ближайшего предшествующего бара (14:00), а не сбой.

### 2. Переписан `timeToPixel`
```typescript
function timeToPixel(chart, candleData, time) {
  if (time == null) return null

  const direct = chart.timeScale().timeToCoordinate(sanitizeTime(time))
  if (direct !== null) return direct  // быстрый путь: точное совпадение

  // Fallback: подбарное время → индекс бара → logical → pixel
  const candleArray = candleData ?? []
  const barIndex = findBarByTime(candleArray, sanitizeTime(time))
  if (barIndex === null) return null
  return chart.timeScale().logicalToCoordinate(barIndex)
}
```

**Логика**: точное совпадение идёт через `timeToCoordinate`, всё остальное — через индекс бара в реальных данных. Никаких допущений о видимом диапазоне.

### 3. `sanitizeTime` нормализует `BusinessDay` и `string` типы
```typescript
function sanitizeTime(time: Time): number | null {
  if (time == null) return null
  if (typeof time === 'number') return time
  if (typeof time === 'string') {
    const parsed = Date.parse(time)
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000)
  }
  // BusinessDay (LWC, для 1d/1w/1M)
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000)
}
```

### 4. `setDrawings` принимает `candleData`
Сигнатура изменена: теперь `primitive.setDrawings(drawings, candleData)`. `candleData` сохраняется в инстансе и используется в `rebuildItems` для пиксельных вычислений.

### 5. `useDrawings` получил `candlesDataRef`
Добавлен восьмой параметр `candlesDataRef: RefObject<UnifiedCandle[]>`. Используется:
- в `setDrawings` для прокидывания в primitive
- в `handleMouseMove` для `timeToPixel` превью
- в click-handler при `coordinateToTime === null` (клик вне видимого диапазона) — `candlesDataRef.current[Math.floor(logicalFromCoord)]?.time`
- в sync-эффекте для повторной сборки при ленивой догрузке истории

## Регрессионные тесты
Файл `client/src/components/charts/drawings/__tests__/primitive.test.ts` переписан: 18 тестов в двух `describe`-блоках.

Ключевой регрессионный кейс — копия бага из тикета:
```typescript
it('1m click at 14:23:15 → switch to 1h → 14:23:00 resolves to bar 14 (14:00)', () => {
  // 25 hourly bars starting at 13:00 (bar 14 = 14:00, bar 15 = 15:00)
  const candles = makeHourlyCandles(25, 13 * 3600)
  const chart = makeChart({ logicalToCoord: idx => idx * 100 + 50 })

  // Сохраняем время клика 14:23 (не существует как 1h-bar time)
  const storedTime = 14 * 3600 + 23 * 60
  const pixel = timeToPixel(chart, candles, storedTime)

  // Должно разрешиться в индекс 14 (14:00), не в NaN/0/случайное значение
  expect(pixel).toBe(14 * 100 + 50)  // 1450
})

it('findBarByTime: target time внутри бара → возвращает индекс этого бара', () => {
  const candles = makeHourlyCandles(25, 13 * 3600)
  expect(findBarByTime(candles, 14 * 3600 + 23 * 60)).toBe(14)
})

it('findBarByTime: target до первого бара → null', () => {
  const candles = makeHourlyCandles(25, 13 * 3600)
  expect(findBarByTime(candles, 12 * 3600)).toBeNull()
})

it('findBarByTime: target после последнего бара → возвращает последний индекс', () => {
  const candles = makeHourlyCandles(25, 13 * 3600)
  expect(findBarByTime(candles, 25 * 3600)).toBe(24)
})
```

## Проверка

- `tsc -b`: clean (исправлены 2 неиспользуемых импорта).
- `vitest run`: 34/34 passed (`primitive.test.ts` 18, `useDrawings.test.tsx` 3, `candle-lifecycle.test.ts` 13).
- `eslint` на 5 затронутых файлах: 62 problems — **все pre-existing**, подтверждено сравнением `git stash` → lint = 62, `git stash pop` → lint = 62. Новый код не вводит ни одной новой lint-проблемы.

## Изменённые файлы
- `client/src/components/charts/drawings/primitive.ts` — `findBarByTime`, переписан `timeToPixel`, `sanitizeTime`, новая сигнатура `setDrawings`
- `client/src/components/charts/drawings/__tests__/primitive.test.ts` — 18 тестов, регрессия на TF-смену
- `client/src/components/charts/useDrawings.tsx` — `candlesDataRef` параметр, click-handler fallback, превью через `timeToPixel`
- `client/src/components/charts/ChartGrid.tsx` — проброс `candlesDataRef` в `useDrawings`
- `client/src/components/charts/__tests__/useDrawings.test.tsx` — обновлён мок для нового параметра
