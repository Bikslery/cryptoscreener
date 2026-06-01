# План: Полная проверка отрисовки последней свечи и сопоставления с текущей ценой

## Цель

Проследить полный путь данных от биржи до пикселя на экране для последней (формирующейся) свечи. Найти расхождения между текущей ценой и тем, что показывает свеча.

---

## Текущая архитектура (полный путь данных)

### Источник 1: Kline WS (Binance → Server → Client)

```
Binance WS: symbol@kline_1m
  → parseCandle(): time=k.t/1000, OHLCV, isFinal=!!k.x
  → candleCallback() → broadcastToChannel('candle:binance-spot:BTCUSDT:1m', candle, immediate=true)
  → hub.ts: ws.send({ type, channel, data: candle }) клиенту
  → client ws.ts: dispatch(msg) → wsOnChannel('candle:binance-spot:BTCUSDT:1m', handler)
  → useWsCandle(): lastBarRef.current = { time, OHLCV }  ← ПОЛНАЯ ПЕРЕЗАПИСЬ
                  candleRef.current.update({ time, OHLCV })  ← LWC series.update()
                  volumeRef.current.update({ time, value, color })
                  candleRef.current.applyOptions({ priceLineColor })
```

### Источник 2: AggTrade WS (Binance → Server → Client)

```
Binance WS: symbol@aggTrade
  → parse: price, volume, time=data.T/1000, isBuyerMaker
  → broadcastToChannel('trade:binance-spot:BTCUSDT', trade, immediate=true)
  → hub.ts: ws.send({ type, channel, data: trade })
  → client ws.ts: dispatch(msg) → wsOnType('trade:binance-spot:BTCUSDT', handler)
  → useWsTrade():
      tradeSec = trade.time (seconds)
      candleTime = floor(tradeSec / tfSeconds) * tfSeconds
      if !bar || tradeSec <= bar.time || tradeSec >= bar.time + tfSeconds:
          lastBarRef.current = { time: candleTime, open: price|bar.open, high: price, low: price, close: price, volume }
      else:
          bar.close = price; bar.high = max(bar.high, price); bar.low = min(bar.low, price); bar.volume += volume
      candleRef.current.update({ time, OHLCV })
      volumeRef.current.update({ time, value, color })
      candleRef.current.applyOptions({ priceLineColor })
```

### Цена в заголовке (MiniChartHeader / ExpandedChartHeader)

```
setLivePrice(symbol, c.close)  ← вызывается из useWsCandle (если !c.isFinal)
setLivePrice(symbol, price)    ← вызывается из useWsTrade
useLivePrice(symbol) → livePrices Map → useSyncExternalStore → рендер
```

---

## Найденные проблемы и подозрительные места

### Проблема 1: Два конкурирующих источника обновляют lastBarRef

`useWsCandle` и `useWsTrade` оба пишут в `lastBarRef.current` и оба вызывают `series.update()`. Порядок обработки непредсказуем.

**Сценарий расхождения:**
1. Trade приходит → `useWsTrade` мутирует `bar.close = 65000`, `bar.high = 65000`
2. Kline приходит сразу после → `useWsCandle` перезаписывает `lastBarRef.current = { close: 64998 }` (старые данные от биржи, ещё не включившие этот trade)
3. На экране: свеча показывает 64998, но `livePrice` из trade = 65000

**Причина**: Binance kline обновляется реже чем aggTrade. Kline может быть "отстающим" на 100-500мс.

### Проблема 2: useWsCandle игнорирует проверку валидности интервала

`useWsCandle` (строка 546-593) перезаписывает `lastBarRef.current` БЕЗ проверки, что время свечи совпадает с текущим интервалом. Если пришёл kline для нового периода — он перезапишет `lastBar`, но `useWsTrade` может потом создать новый bar для текущего периода, затирая kline-данные.

### Проблема 3: race condition при смене таймфрейма/символа

`useWsTrade` (строка 617) делает `lastBarRef.current = null` при монтировании.
`useWsCandle` этого НЕ делает.

Если символ/TF меняются:
- `useWsTrade` сбрасывает `lastBarRef`
- `useWsCandle` может ещё успеть обработать старое сообщение и записать stale bar
- Оба эффекта зависят от `[symbol, tf]` — React не гарантирует порядок их выполнения

### Проблема 4: Kline перезаписывает trade-built свечу целиком

Строка 551-558:
```ts
lastBarRef.current = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
```

ScalpBoard делает то же самое (`G = N`), но ScalpBoard НЕ имеет второго источника (trade). У нас trade-построенная свеча может быть точнее (т.к. каждый тик обновляет close/high/low), а kline её перезаписывает "официальными" но отстающими данными.

### Проблема 5: Валидация интервала в useWsTrade — условие `tradeSec <= bar.time`

Строка 653:
```ts
if (!bar || tradeSec <= bar.time || tradeSec >= bar.time + tfSeconds)
```

ScalpBoard: `oe > G.time && oe < G.time + interval` — строго ВНУТРИ.

У нас `tradeSec <= bar.time` означает: trade с timestamp РАВНЫМ началу свечи тоже создаёт новую. ScalpBoard пропускает такой trade (т.к. `>` не `>=`).

Это может создать лишнюю свечу, если trade.time точно равен `candleTime`.

### Проблема 6: Hub батчит trade-сообщения

`broadcastToChannel('trade:...', data, immediate=true)` — `immediate=true` обходит батчинг.

НО: `broadcastToChannel('candle:...', candle, true)` — тоже immediate.

Оба источника отправляются мгновенно. Но latency между aggTrade и kline на стороне Binance может быть 200-2000мс.

### Проблема 7: priceLine через applyOptions вместо встроенной линии

Строки 591-593 и 712-714:
```ts
candleRef.current.applyOptions({ priceLineColor: bar.close >= bar.open ? UP_COLOR() : DOWN_COLOR() })
```

Это обновляет ЦВЕТ линии, но сама линия — встроенная `priceLineVisible: true`. LWC автоматически рисует price line на уровне `close` последнего бара при `series.update()`. Проблем нет — цена линии = close свечи.

**Но**: если `livePrice` в заголовке пришёл из trade, а свеча обновилась из kline с другим `close` — расхождение заголовок vs свеча.

### Проблема 8: setLivePrice вызывается из обоих источников

`useWsCandle`: `if (!c.isFinal) setLivePrice(symbol, c.close)` — только для незавершённых свечей
`useWsTrade`: `setLivePrice(symbol, price)` — всегда

Trade устанавливает цену чаще. Но kline может её перезаписать назад (устаревшим close).

---

## План проверки (step-by-step)

### Шаг 1: Добавить debug-логирование в useWsCandle и useWsTrade

В обоих обработчиках добавить `console.debug` с:
- timestamp (Date.now())
- источник ('kline' / 'trade')
- price / close
- lastBarRef.current.close (до и после обновления)

Файл: `client/src/components/charts/ChartGrid.tsx`

### Шаг 2: Сравнить livePrice с lastBarRef.current.close

Добавить реактивную проверку: если `useLivePrice(symbol)` !== `lastBarRef.current?.close` — логировать расхождение.

### Шаг 3: Визуальная проверка в браузере

Открыть один символ на ScalpBoard и нашем скринере рядом.
Сравнить:
- Позицию price line (горизонтальная линия на close)
- Значение close в заголовке
- Форму последней свечи (high/low/close) при быстром движении цены
- Задержку обновления при резком изменении

### Шаг 4: Проверить timing kline vs trade на сервере

Добавить серверный лог: timestamp получения kline и trade для одного символа.
Оценить среднюю задержку kline относительно trade.

Файл: `server/src/services/exchanges/binance-spot.ts` (в candlePool callback)
Файл: `server/src/services/trades/aggTrade.ts` (в on('message'))

---

## Рекомендуемые исправления

### Исправление 1: Kline не должен перезаписывать trade-built свечу если trade новее

**Подход**: в `useWsCandle`, перед перезаписью `lastBarRef.current`, сравнить `c.time` с `lastBarRef.current?.time`. Если совпадают — обновить только `open` и `volume` (точные данные от биржи), но сохранить `close/high/low` из trade если они новее (определять по `lastUpdateRef`).

```ts
if (bar && bar.time === c.time) {
  // Kline: точные open + volume, но close/high/low из trade могут быть новее
  bar.open = c.open          // биржа точнее
  bar.volume = c.volume      // биржа точнее
  // close/high/low — оставить trade если обновление было <2с назад
} else {
  lastBarRef.current = { time, OHLCV }  // новая свеча — полная перезапись
}
```

### Исправление 2: Сброс lastBarRef при смене символа/TF — в обоих хуках

Добавить `lastBarRef.current = null` в `useWsCandle` при монтировании (как в `useWsTrade`).

### Исправление 3: Валидация tradeSec >= bar.time (включительно)

Изменить `tradeSec <= bar.time` на `tradeSec < bar.time` — trade в точности равный началу свечи должен обновлять эту свечу, а не создавать новую.

### Исправление 4: Устранить расхождение livePrice vs свеча

После `series.update()` в `useWsCandle`, НЕ вызывать `setLivePrice` если kline отстаёт. Вместо этого — сравнить kline.close с текущим livePrice, и обновить только если kline новее.

---

## Файлы

| Файл | Изменения |
|------|-----------|
| `client/src/components/charts/ChartGrid.tsx` | useWsCandle: умное слияние kline+trade; useWsTrade: исправить граничное условие; сброс lastBarRef в обоих хуках |
| `client/src/services/ws.ts` | Без изменений (работает корректно) |
| `server/src/services/exchanges/binance-spot.ts` | Debug-логирование (временно) |
| `server/src/services/trades/aggTrade.ts` | Debug-логирование (временно) |
| `server/src/ws/hub.ts` | Без изменений |

## Валидация

1. `npx tsc -p tsconfig.app.json --noEmit` — 0 ошибок
2. Визуальное сравнение side-by-side со ScalpBoard
3. Debug-лог: расхождения livePrice vs lastBarRef.close = 0 при стабильном соединении
4. Нет дублирующихся свечей при trade.time === candleTime

## Риски

- Умное слияние kline+trade может давать неточные high/low если kline ещё не включил последний тик
- Изменение граничного условия `tradeSec < bar.time` может создать свечи с time из будущего если trade.time некорректен
- Debug-логирование может замедлить высокочастотные пары (убрать после проверки)

## Открытые вопросы

1. Какая максимально допустимая задержка kline относительно trade? (Binance spec: ~100-500мс)
2. Нужно ли показывать "теневую" цену (trade-based) пока kline не обновился?
3. Должен ли `isFinal` от kline блокировать дальнейшие trade-updates для этой свечи?
