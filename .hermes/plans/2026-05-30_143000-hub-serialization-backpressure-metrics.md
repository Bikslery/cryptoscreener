# Plan: hub.ts — Serialization Cache, Backpressure Drop, Prometheus Metrics

## Goal

Три улучшения WS-хаба:

1. **Кэш сериализации по сигнатуре подписок** — избегать повторного `JSON.stringify` одинаковых payloads для клиентов с одинаковой сигнатурой подписок
2. **Backpressure drop-стратегия** — вместо молчаливого `continue` при `buffered >= MAX_BUFFERED` активно отключать/уведомлять медленных клиентов
3. **Prometheus-метрики** — gauges/counters/histograms на WS-коннекты, rate-limiter weight, broadcast lag

---

## Current State

- `hub.ts` (271 строка) — единственный файл WS-хаба
- `MAX_BUFFERED = 50` — клиент с `buffered >= 50` просто пропускается в broadcast, соединение живёт до следующего ping-таймаута (30с)
- `broadcast()` — `JSON.stringify(msg)` вызывается **один раз** для не-ticker сообщений, но для ticker — **N раз** (фильтрация per-client `tickerSymbols`), каждый клиент со специфичными подписками получает отдельный stringify
- `flushBatchBuffer()` — та же проблема: `raw = JSON.stringify(msg)` лениво один раз, но только для клиентов без per-client фильтрации
- Prometheus зависимостей нет (`npm ls prom-client` → 404)
- Debug-роут (`/api/debug/candle-stats`) — нет WS-статистики
- `rate-limiter.ts` — `getWeight()/getLimit()` доступны, но не экспонируются наружу

---

## Task 1: Serialization Cache by Subscription Signature

### Problem

Ticker broadcast: для каждого клиента с `tickerSymbols.size > 0` вызывается `JSON.stringify({ type: 'ticker', data: filtered })`. Если 100 клиентов подписаны на одни и те же 5 символов — 100 идентичных stringify.

### Approach

**Signature = sorted joined tickerSymbols** (или sorted subscriptions для канальных сообщений). Map<signature, serialized>. Инвалидируется каждый flush-цикл (100ms).

### Steps

1. В `flushBatchBuffer()`:
   - Группировать клиентов по `signature = [...client.subscriptions].sort().join(',')`
   - Для каждой группы — один `JSON.stringify(msg)`, отправить всем клиентам группы
   - Кэш живёт внутри одного вызова `flushBatchBuffer()`, не персистентный

2. В `broadcast()` для ticker:
   - Аналогично: Map<signature, string>
   - Signature для ticker = `[...client.tickerSymbols].sort().join(',')`
   - `filtered = tickers.filter(t => client.tickerSymbols.has(t.symbol))` — один раз на сигнатуру
   - `JSON.stringify({ type: 'ticker', data: filtered })` — один раз на сигнатуру
   - Отправить `raw` всем клиентам с той же сигнатурой

3. Оптимизация: для клиентов с `tickerSymbols.size === 0` (подписаны на все тикеры) — уже есть `fullRaw`, отдельная группа

### Files to change

- `server/src/ws/hub.ts` — `broadcast()`, `flushBatchBuffer()`

### Validation

- Логирование: при `DEBUG=ws-serialization` считать hits/misses кэша, выводить в `flushBatchBuffer`
- Smoke test: подключить 2 клиента с одинаковыми подписками, убедиться что `JSON.stringify` вызывается 1 раз (через временное логирование)

---

## Task 2: Backpressure Drop Strategy

### Problem

Сейчас: `buffered >= MAX_BUFFERED → continue`. Клиент тихо теряет данные, соединение живёт до ping timeout (30с). Нет обратной связи. Нет логирования.

### Approach

**Двухуровневая стратегия:**

- **Level 1 (soft)** — `buffered >= MAX_BUFFERED` → пропустить отправку, но отправить клиенту `{ type: "backpressure", dropped: true }` (thin notification, не интерактивный, не блокирует)
- **Level 2 (hard)** — `buffered >= MAX_BUFFERED * 2` (или N последовательных пропусков без pong) → `ws.close(1008, 'backpressure')`, форсированное отключение

### Steps

1. Добавить константы:
   ```
   const MAX_BUFFERED = 50           // уже есть
   const BACKPRESSURE_HARD_LIMIT = 100  // = MAX_BUFFERED * 2
   const BACKPRESSURE_NOTIFY_INTERVAL = 5000  // ms, не спамить уведомлениями
   ```

2. Расширить интерфейс `Client`:
   ```ts
   lastBackpressureNotify: number   // timestamp последнего уведомления
   totalDropped: number             // счётчик сброшенных сообщений (для метрик)
   ```

3. В `broadcast()` и `flushBatchBuffer()`:
   - При `buffered >= MAX_BUFFERED`:
     - `client.totalDropped++`
     - Если `Date.now() - client.lastBackpressureNotify > BACKPRESSURE_NOTIFY_INTERVAL`:
       - `ws.send(JSON.stringify({ type: 'backpressure', dropped: true }))` (с проверкой `readyState === OPEN`)
       - `client.lastBackpressureNotify = Date.now()`
   - При `buffered >= BACKPRESSURE_HARD_LIMIT`:
     - `ws.close(1008, 'backpressure')`
     - `cleanupClient(client)`
     - `clients.delete(ws)`
     - Лог: `[Hub] Client dropped (backpressure), buffered=${client.buffered}`

4. В pong handler: `client.buffered = 0` — уже есть, сбрасывает `totalDropped` не нужно (это累计 счётчик для метрик)

5. Добавить `getHubStats()` — экспортируемая функция:
   ```ts
   export function getHubStats() {
     let totalClients = 0, totalSubscriptions = 0, maxBuffered = 0, totalDropped = 0
     for (const c of clients.values()) {
       totalClients++
       totalSubscriptions += c.subscriptions.size
       if (c.buffered > maxBuffered) maxBuffered = c.buffered
       totalDropped += c.totalDropped
     }
     return { totalClients, totalSubscriptions, maxBuffered, totalDropped }
   }
   ```

6. Добавить WS-стат в debug-роут:
   - `server/src/routes/debug.ts` — импорт `getHubStats`, добавить в `/candle-stats` ответ или новый эндпоинт `/ws-stats`

### Files to change

- `server/src/ws/hub.ts` — Client interface, broadcast/flushBatchBuffer logic, `getHubStats()`
- `server/src/routes/debug.ts` — WS stats endpoint

---

## Task 3: Prometheus Metrics

### Problem

Нет observability. Нельзя понять: сколько WS-клиентов, как быстро рассылается broadcast, какой weight у rate-limiter.

### Approach

**`prom-client`** — стандартный Node.js Prometheus client. Minimal footprint.

### Steps

1. **Install**: `cd server && npm install prom-client`

2. **New file**: `server/src/metrics.ts`
   ```ts
   import client from 'prom-client'

   const register = new client.Registry()
   client.collectDefaultMetrics({ register, prefix: 'cs_' })

   // --- WS Hub ---
   export const wsClientsGauge = new client.Gauge({
     name: 'cs_ws_clients_connected',
     help: 'Currently connected WS clients',
     registers: [register]
   })

   export const wsSubscriptionsGauge = new client.Gauge({
     name: 'cs_ws_subscriptions_total',
     help: 'Total active WS subscriptions across all clients',
     registers: [register]
   })

   export const wsBufferedMaxGauge = new client.Gauge({
     name: 'cs_ws_buffered_max',
     help: 'Max buffered count among connected clients',
     registers: [register]
   })

   export const wsDroppedCounter = new client.Counter({
     name: 'cs_ws_messages_dropped_total',
     help: 'Total WS messages dropped due to backpressure',
     registers: [register]
   })

   export const wsBroadcastLatency = new client.Histogram({
     name: 'cs_ws_broadcast_duration_seconds',
     help: 'Time spent in broadcast()',
     buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
     registers: [register]
   })

   // --- Rate Limiter ---
   export const rateLimitWeightGauge = new client.Gauge({
     name: 'cs_ratelimit_weight_current',
     help: 'Current API weight used',
     labelNames: ['market'],  // spot / futures
     registers: [register]
   })

   export const rateLimitWeightMaxGauge = new client.Gauge({
     name: 'cs_ratelimit_weight_limit',
     help: 'API weight limit',
     labelNames: ['market'],
     registers: [register]
   })

   export const rateLimitThrottledCounter = new client.Counter({
     name: 'cs_ratelimit_throttled_total',
     help: 'Number of times rate limiter throttled requests',
     labelNames: ['market'],
     registers: [register]
   })

   export { register }
   ```

3. **Wire metrics in hub.ts**:
   - Импорт метрик
   - В `flushBatchBuffer()` — обернуть в `wsBroadcastLatency.startTimer()` / `endTimer()`
   - В `broadcast()` — аналогично
   - Периодический refresh gauges (каждые 5с или lazy — обновлять при запросе `/metrics`):
     ```ts
     export function refreshMetrics() {
       const stats = getHubStats()
       wsClientsGauge.set(stats.totalClients)
       wsSubscriptionsGauge.set(stats.totalSubscriptions)
       wsBufferedMaxGauge.set(stats.maxBuffered)
       wsDroppedCounter.inc(stats.totalDropped - (lastDroppedSnapshot || 0))  // delta
       lastDroppedSnapshot = stats.totalDropped
     }
     ```
   - В backpressure drop — `wsDroppedCounter.inc()`

4. **Wire metrics in rate-limiter.ts**:
   - Импорт `rateLimitWeightGauge`, `rateLimitWeightMaxGauge`, `rateLimitThrottledCounter`
   - В `updateFromHeaders()` — `rateLimitWeightGauge.set({ market: this.market }, this.currentWeight)`
   - В конструкторе — `rateLimitWeightMaxGauge.set({ market: this.market }, this.limit)`
   - В `waitIfThrottled()` — `rateLimitThrottledCounter.inc({ market: this.market })` при входе в throttle

5. **Expose /metrics endpoint** в `index.ts`:
   ```ts
   import { register } from './metrics.js'
   app.get('/metrics', async (_req, res) => {
     res.set('Content-Type', register.contentType)
     res.end(await register.metrics())
   })
   ```
   - Опционально: добавить `METRICS_AUTH` env — если true, требовать JWT или Bearer token (для production)

6. **Refresh strategy**:
   - Lazy: вызывать `refreshMetrics()` в обработчике `/metrics` перед `register.metrics()`
   - Это лучше чем setInterval — нет фонового CPU, метрики свежие при scrape

### Files to change

- `server/package.json` — добавить `prom-client`
- `server/src/metrics.ts` — новый файл
- `server/src/ws/hub.ts` — интеграция метрик
- `server/src/services/exchanges/rate-limiter.ts` — интеграция метрик
- `server/src/index.ts` — `/metrics` endpoint

### Validation

- `curl localhost:3001/metrics` — видеть `cs_ws_clients_connected`, `cs_ratelimit_weight_current{market="spot"}`, etc.
- Подключить WS клиент, подписаться → gauges растут
- Нагрузить broadcast → histogram заполняется
- Проверить что `tsc --noEmit` чистый

---

## Execution Order

1. Task 2 (backpressure) — не зависит от других, даёт `getHubStats()` и `totalDropped`
2. Task 3 (metrics) — использует `getHubStats()` из Task 2
3. Task 1 (serialization cache) — последний, чисто оптимизация

---

## Risks & Tradeoffs

| Risk | Mitigation |
|------|-----------|
| Serialization cache: signature совпадает редко при уникальных подписках | Кэш per-flush, нулевая стоимость при miss. Убираем если профилирование покажет overhead на группировку |
| Backpressure close(1008) — клиент теряет данные | Это ок — медленный клиент уже теряет данные молча. close() лучше чем zombie connection |
| `prom-client` adds ~30KB | Стандартная зависимость для Node.js observability, overhead минимальный |
| `/metrics` без auth — утечка инфраструктурной информации | Опциональный `METRICS_AUTH` env. В docker-compose по умолчанию internal network |
| Refresh metrics lazy vs interval | Lazy проще, но scrapes могут быть редкими — gauges устаревают. Приемлемо для ws-коннектов (медленно меняются) |

---

## Open Questions

1. **Signature granularity** — группировать по полному `subscriptions` Set или отдельно ticker vs candle/depth? Тикеры фильтруются по `tickerSymbols`, остальные — по `subscriptions.has(channel)`. Возможно две отдельных Map.
2. **METRICS_AUTH** — реализовать сразу или оставить TODO? (рекомендую TODO, добавить флаг)
3. **Backpressure notify** — отправлять `{ type: 'backpressure' }` или просто логировать на сервере? Клиент может не обрабатывать. (рекомендую и то и то — notify + лог)
4. **Histogram buckets** — подобрать под реальные broadcast times после нагрузки
