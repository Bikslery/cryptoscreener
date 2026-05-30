# P0: Агрегатор — приоритеты бирж + дедуп символов + инкрементальный WS

## Цель

Две P0-задачи, без которых нет реалтайм-скринера:

1. **aggregator/**: конфигурируемая модель приоритетов бирж + дедупликация символов (конфиг через env/БД)
2. **ws-pool.ts**: инкрементальные SUBSCRIBE/UNSUBSCRIBE вместо полного реконнекта при каждом изменении набора стримов

---

## Контекст / текущее состояние

### Агрегатор (`server/src/services/aggregator/index.ts`)

- Приоритеты уже **зашиты хардкодом**:
  ```ts
  const EXCHANGE_PRIORITY: Record<string, number> = {
    'binance-futures': 5,
    'bybit-futures': 4,
    'okx-spot': 3,
    'binance-spot': 2,
  }
  ```
- Дедуп символов частично работает через `pickBestFromMap()` — из `tickerMap` (ключ `symbol:exchange`) выбирается тикер с наивысшим приоритетом для каждого символа.
- Проблемы:
  - Приоритеты не конфигурируемы (только редактирование кода).
  - Нет поддержки per-symbol override (например, для монеты OKX может быть лучше, чем Binance Futures, но это нельзя указать).
  - Нет понятия «чёрный список символов на бирже» — если символ торгуется, он всегда подхватывается.
  - `adaptersByPriority()` каждый раз сортирует массив — нет кэша.

### WS-Pool (`server/src/services/exchanges/ws-pool.ts`)

- Текущая модель: **полный реконнект** при любом изменении набора стримов.
  - `addStream()` → добавляет стрим в `conn.streams`, вызывает `scheduleReconnect()`.
  - `removeStream()` → удаляет стрим, вызывает `scheduleReconnect()`.
  - `scheduleReconnect()` → через 300 мс убивает ВСЕ WS-соединения и пересоздаёт их с новым URL `?streams=a/b/c`.
- Это означает:
  - При каждом add/remove стрима — разрыв WS, потеря данных на время реконнекта.
  - Скрейпер подписывается/отписывается от candle/depth при открытии/закрытии чарта — каждый раз полный реконнект.
  - Лимит 200 стримов на соединение (Binance), но при перебалансировке всё равно всё рвётся.

- Binance WS API поддерживает инкрементальные подписки через JSON-команды:
  ```json
  { "method": "SUBSCRIBE", "params": ["btcusdt@kline_1m"], "id": 1 }
  { "method": "UNSUBSCRIBE", "params": ["btcusdt@kline_1m"], "id": 2 }
  ```

---

## Подход

### Задача 1: Агрегатор — конфигурируемые приоритеты + дедуп

**Конфиг через env-переменные** (проще, нет зависимости от БД при старте, можно оверрайдить при деплое):

```
EXCHANGE_PRIORITY=binance-futures:5,bybit-futures:4,okx-spot:3,binance-spot:2
EXCHANGE_SYMBOL_BLACKLIST=binance-spot:BTCUSDT;okx-spot:ETHUSDT
```

**Per-symbol override** — через env-переменную с JSON (редко меняется, для особых случаев):
```
EXCHANGE_SYMBOL_OVERRIDES={"PEPEUSDT":{"okx-spot":6}}
```

Либо через БД-таблицу `ExchangePriority` (на будущее — для админки), но P0 = env.

**Шаги:**

1. Вынести `EXCHANGE_PRIORITY` в конфиг, парсить из env при старте, с fallback на текущий хардкод.
2. Добавить `EXCHANGE_SYMBOL_BLACKLIST` — сет пар (exchange, symbol), которые игнорируются в `processTickerArray` каждого адаптера и в `pickBestFromMap`.
3. Добавить `EXCHANGE_SYMBOL_OVERRIDES` — мапа `symbol → { exchange: priority }`, которая подмешивается в `pickBestFromMap` при выборе лучшего тикера для символа.
4. Заменить `EXCHANGE_PRIORITY` хардкод на функцию `getPriority(exchange, symbol?)`, которая учитывает overrides.
5. Кэшировать `adaptersByPriority()` — пересчитывать только при изменении конфига.
6. Добавить логирование итоговой конфигурации приоритетов при старте.

### Задача 2: ws-pool.ts — инкрементальные SUBSCRIBE/UNSUBSCRIBE

**Модель:**

- При `addStream(stream)`: если WS уже открыт — отправить `{"method":"SUBSCRIBE","params":[stream],"id":N}`. Если нет — добавить в `conn.streams`, дождаться подключения (стримы автоматически будут в URL при следующем реконнекте, но обычно коннект уже жив).
- При `removeStream(stream)`: отправить `{"method":"UNSUBSCRIBE","params":[stream],"id":N}`. Удалить из `conn.streams`. Если `conn.streams.size === 0` — закрыть WS.
- `scheduleReconnect()` вызывается только при: (а) первоначальном подключении (нет живого WS), (б) неожиданном разрыве WS.
- При неожиданном разрыве (close без intentionalClose) — реконнект с полным набором стримов (как сейчас).

**Важно:** Binance combined stream URL (`?streams=a/b/c`) устанавливает *начальный* набор. После подключения можно менять набор через SUBSCRIBE/UNSUBSCRIBE. Нужен переходный период: при первоначальном подключении используем URL (как сейчас), а потом — инкрементально.

**Шаги:**

1. Добавить метод `sendSubscribe(conn, streams: string[])` — шлёт `{"method":"SUBSCRIBE","params":streams,"id":nextId()}`.
2. Добавить метод `sendUnsubscribe(conn, streams: string[])` — шлёт `{"method":"UNSUBSCRIBE","params":streams,"id":nextId()}`.
3. Модифицировать `addStream()`:
   - Если целевой `conn.ws` жив (OPEN) — отправить SUBSCRIBE немедленно.
   - Если WS не открыт — добавить в `conn.streams` и дождаться `connectSingle` (стримы попадут в URL или будут подписаны после open).
4. Модифицировать `removeStream()`:
   - Если `conn.ws` жив — отправить UNSUBSCRIBE немедленно.
   - Удалить из `conn.streams`.
   - Если `conn.streams.size === 0` — закрыть WS (как сейчас).
   - Убрать `scheduleReconnect()` из `removeStream`.
5. Модифицировать `doReconnect()` / `connectSingle()`:
   - При первоначальном подключении — URL с `?streams=...` как сейчас.
   - Убрать вызов `scheduleReconnect` из `addStream` — заменить на немедленный SUBSCRIBE.
6. Добавить инкрементный ID-счётчик для correlation request/response (id в SUBSCRIBE/UNSUBSCRIBE).
7. Обработка `conn.streams` при балансировке: если при `addStream` найден `conn` с `< MAX_STREAMS_PER_CONN` и живым WS — SUBSCRIBE; иначе — новый `conn` + connectSingle.
8. Перебалансировка: если после UNSUBSCRIBE в conn остаётся мало стримов, можно (опционально, не P0) мигрировать стримы между коннектами. Пока не делаем.

---

## Файлы, которые будут изменены

### Задача 1 (агрегатор + конфиг)

| Файл | Изменение |
|------|-----------|
| `server/src/services/aggregator/index.ts` | Вынести `EXCHANGE_PRIORITY` в функцию `getPriority()`, добавить парсинг env, blacklist, overrides, обновить `pickBestFromMap` |
| `server/src/services/exchanges/binance-spot.ts` | Пробросить blacklist в `processTickerArray` (опционально — можно фильтровать на уровне агрегатора) |
| `server/src/services/exchanges/binance-futures.ts` | Аналогично |
| `server/src/services/exchanges/okx-spot.ts` | Аналогично |
| `server/src/services/exchanges/bybit-futures.ts` | Аналогично |

### Задача 2 (ws-pool)

| Файл | Изменение |
|------|-----------|
| `server/src/services/exchanges/ws-pool.ts` | Основной файл — инкрементальные SUBSCRIBE/UNSUBSCRIBE, убрать full-reconnect при add/remove |

---

## Пошаговый план

### Шаг 1: Конфиг приоритетов — env-парсинг (aggregator/index.ts)

- Создать `parseExchangePriority(envStr: string): Record<string, number>` — парсит `"binance-futures:5,bybit-futures:4"`.
- Создать `parseBlacklist(envStr: string): Map<string, Set<string>>` — парсит `"binance-spot:BTCUSDT,ETHUSDT;okx-spot:ETHUSDT"`.
- Создать `parseOverrides(envStr: string): Map<string, Map<string, number>>` — парсит JSON `{"PEPEUSDT":{"okx-spot":6}}`.
- Заменить `EXCHANGE_PRIORITY` хардкод на `const DEFAULT_PRIORITY` + чтение из `process.env.EXCHANGE_PRIORITY`.
- Создать `function getPriority(exchange: string, symbol?: string): number` — с учётом overrides.

### Шаг 2: Обновить pickBestFromMap (aggregator/index.ts)

- В `pickBestFromMap`: фильтровать тикеры, чей `(exchange, symbol)` в blacklist.
- При сравнении приоритетов — использовать `getPriority(exchange, symbol)` вместо `EXCHANGE_PRIORITY[t.exchange]`.

### Шаг 3: Проброс blacklist в адаптеры (опционально)

- Два подхода:
  - (A) Фильтровать на уровне агрегатора — просто, достаточно для P0. Blacklist применяется в `pickBestFromMap`.
  - (B) Передавать blacklist в каждый адаптер — меньше памяти (не храним ненужные тикеры в tickerMap).
- **Рекомендация для P0**: вариант (A) — проще, blacklist обычно маленький.

### Шаг 4: ws-pool.ts — добавить инкрементальный протокол

- Добавить поле `private nextReqId = 1`.
- Добавить метод `private sendCommand(conn: PoolConn, method: 'SUBSCRIBE'|'UNSUBSCRIBE', params: string[])`:
  ```ts
  if (conn.ws?.readyState !== WebSocket.OPEN) return
  conn.ws.send(JSON.stringify({ method, params, id: this.nextReqId++ }))
  ```

### Шаг 5: ws-pool.ts — переделать addStream

```ts
addStream(stream: string) {
  // Найти conn с местом
  let target = this.connections.find(c => c.streams.size < MAX_STREAMS_PER_CONN)
  if (!target) {
    target = { ws: null, streams: new Set(), generation: 0 }
    this.connections.push(target)
  }
  if (target.streams.has(stream)) return  // уже подписаны
  target.streams.add(stream)

  if (target.ws?.readyState === WebSocket.OPEN) {
    // Живой WS — инкрементальная подписка
    this.sendCommand(target, 'SUBSCRIBE', [stream])
  } else if (!target.ws) {
    // Нет WS — запустить подключение
    this.connectSingle(target)
  }
  // Если WS в состоянии CONNECTING — подписка будет обработана после open
  //   (стрим уже в conn.streams, connectSingle добавит его в URL или подпишется после open)
}
```

### Шаг 6: ws-pool.ts — переделать removeStream

```ts
removeStream(stream: string) {
  for (const conn of this.connections) {
    if (!conn.streams.delete(stream)) continue  // не было этого стрима

    if (conn.ws?.readyState === WebSocket.OPEN) {
      this.sendCommand(conn, 'UNSUBSCRIBE', [stream])
    }

    if (conn.streams.size === 0) {
      conn.generation++
      try { conn.ws?.close() } catch {}
      conn.ws = null
    }
  }
  this.connections = this.connections.filter(c => c.streams.size > 0)
  // НЕТ scheduleReconnect — мы уже отписались инкрементально
}
```

### Шаг 7: ws-pool.ts — обработка pending-подписок при open

- В `connectSingle`, в обработчике `on('open')`:
  - Если `conn.streams` содержит стримы, которые ещё не были подписаны (новые, добавленные пока WS был в CONNECTING) — отправить SUBSCRIBE для всех стримов.
  - Альтернатива: строить URL с `?streams=` как сейчас для начального набора, и дополнительно SUBSCRIBE любые стримы, добавленные после начала подключения.
- **Рекомендация**: при `connectSingle` — URL с `?streams=` (все текущие стримы), как сейчас. Это гарантирует, что все стримы подключены. SUBSCRIBE/UNSUBSCRIBE используется только для *последующих* изменений.

### Шаг 8: Убрать scheduleReconnect из addStream

- `scheduleReconnect` оставить только для восстановления после неожиданного разрыва.
- `addStream` больше не вызывает `scheduleReconnect`.
- `removeStream` больше не вызывает `scheduleReconnect`.

### Шаг 9: Логирование и метрики

- Добавить логи: `[WsPool] SUBSCRIBE btcusdt@kline_1m (conn #2, streams: 45/200)`.
- Добавить логи: `[WsPool] UNSUBSCRIBE ethusdt@kline_1m (conn #1, streams: 38/200)`.
- Логировать при первоначальном подключении как сейчас.

---

## Тестирование / валидация

1. **Приоритеты:**
   - Запустить с `EXCHANGE_PRIORITY=binance-spot:10,binance-futures:5` — убедиться, что для дублей символов выбирается binance-spot.
   - Запустить с `EXCHANGE_SYMBOL_BLACKLIST=binance-spot:BTCUSDT` — убедиться, что BTCUSDT не показывается от binance-spot.
   - Запустить с `EXCHANGE_SYMBOL_OVERRIDES={"PEPEUSDT":{"okx-spot":10}}` — убедиться, что PEPEUSDT берётся с okx-spot.

2. **Инкрементальный WS:**
   - Открыть чарт → проверить, что SUBSCRIBE отправлен без реконнекта (нет лога "WS connecting").
   - Закрыть чарт → проверить, что UNSUBSCRIBE отправлен без реконнекта.
   - Открыть >200 стримов → проверить, что создаётся второе соединение.
   - Убить WS (network issue) → проверить, что происходит реконнект с полным набором стримов.
   - Проверить, что данные продолжают поступать после SUBSCRIBE (кандлы обновляются).

3. **Регрессия:**
   - Базовый сценарий: все тикеры грузятся, чарты рисуются, алерты работают.
   - Многократное открытие/закрытие чартов — нет утечки памяти/соединений.

---

## Риски и компромиссы

1. **Binance SUBSCRIBE/UNSUBSCRIBE — не все биржи поддерживают.** OKX и Bybit используют другой WS-протокол (op-based). Инкрементальные подписки нужны только для Binance-пулов (candlePool, depthPool). OKX/Bybit пока не используют WsStreamPool (у них TODO в subscribeCandle). **Решение:** инкрементальный режим включать опционально — по флагу `supportsIncrementalSub: boolean` в конструкторе WsStreamPool.

2. **Race condition при CONNECTING.** Если `addStream` вызван, пока WS в состоянии CONNECTING — стрим нужно подписать после open. **Решение:** в `on('open')` обработать — стримы уже в `conn.streams`, они попадут в начальный URL при `connectSingle`, либо нужно отправить SUBSCRIBE. В зависимости от того, вызывался ли `connectSingle` или `doReconnect`. **Проще всего:** при первоначальном подключении всегда строить URL из `conn.streams` (как сейчас), а SUBSCRIBE/UNSUBSCRIBE — только при живом OPEN-соединении.

3. **Перебалансировка стримов между коннектами.** Если после UNSUBSCRIBE в одном коннекте стало 5 стримов, а в другом 195 — оптимально перераспределить. Это не P0, оставляем на потом.

4. **Env-конфиг vs БД.** Env проще для P0, но не позволяет менять приоритеты на лету без рестарта. Можно добавить в будущем: таблица `ExchangePriority` в Prisma, при старте — env как fallback.

---

## Открытые вопросы

1. Нужно ли пробрасывать blacklist в адаптеры (вариант B) или достаточно фильтрации в агрегаторе (вариант A)?
2. Нужно ли поддерживать per-symbol priority overrides через БД, или env достаточно для P0?
3. OKX/Bybit TODO-subscribeCandle — нужно ли реализовывать в этом итеративном цикле или отдельно?
4. Лимит 200 стримов на Binance-соединение — менять на 100 (более стабильно) или оставить 200?
