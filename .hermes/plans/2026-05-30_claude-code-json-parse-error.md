# План: Диагностика "API Error: Failed to parse JSON" в Claude Code

## Проблема
При работе в Claude Code появляется ошибка `API Error: Failed to parse JSON` и агент перестает работать.

## Контекст
- Claude Code v2.1.158
- Используется кастомный прокси: `ANTHROPIC_BASE_URL=https://cc.freemodel.dev`
- API ключ: `fe_oa_...` (ключ прокси, не официальный Anthropic)
- Модели: claude-opus-4-8, claude-opus-4-7, claude-haiku-4-5, qwen3.5-4b-64k

## Корневые причины (по вероятности)

### 1. Прокси возвращает невалидный JSON (80% вероятность)
Прокси `cc.freemodel.dev` может:
- Возвращать HTML-страницу ошибки вместо JSON (502, 503, 429)
- Обрывать потоковое соединение посреди SSE-фрейма
- Возвращать JSON с полями, которых Claude Code не ожидает
- Не поддерживать streaming format Anthropic API полностью

### 2. Прокси несовместим с конкретными API-вызовами (15%)
Claude Code делает несколько типов запросов:
- `/v1/messages` (основной чат)
- `/v1/messages` с `stream: true` (потоковый вывод)
- Возможно другие эндпоинты (model list и т.д.)

Прокси может не поддерживать все форматы ответов.

### 3. Размер контекста / ответа (5%)
При длинных ответах (кодогенерация) прокси может обрезать ответ.

## Шаги диагностики

### Шаг 1: Проверить, что именно возвращает прокси
```bash
# Простой тест — не-стриминг запрос
curl -s -X POST https://cc.freemodel.dev/v1/messages \
  -H "x-api-key: fe_oa_c164ab5aae6332aaf87642bc4ca98dbd136aec5d8f90cefb" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"Say hi"}]}'

# Стриминг запрос
curl -s -X POST https://cc.freemodel.dev/v1/messages \
  -H "x-api-key: fe_oa_c164ab5aae6332aaf87642bc4ca98dbd136aec5d8f90cefb" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Say hi"}]}'
```
Ожидание: валидный JSON / SSE-поток. Если HTML или мусор — прокси виноват.

### Шаг 2: Проверить логи Claude Code
```bash
# Логи лежат в
ls ~/.claude/logs/ 2>/dev/null || echo "no logs dir"

# Или запустить Claude Code с debug
DEBUG=* claude
```

### Шаг 3: Временно переключиться на прямой API
Если есть официальный Anthropic API ключ:
```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "ANTHROPIC_BASE_URL": ""  // удалить или оставить пустым
  }
}
```
Если ошибка исчезнет — 100% проблема прокси.

### Шаг 4: Проверить стабильность прокси
```bash
# 10 запросов подряд — проверить % ошибок
for i in $(seq 1 10); do
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST https://cc.freemodel.dev/v1/messages \
    -H "x-api-key: fe_oa_c164ab5aae6332aaf87642bc4ca98dbd136aec5d8f90cefb" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"claude-sonnet-4-20250514","max_tokens":50,"messages":[{"role":"user","content":"Say ok"}]}')
  echo "Request $i: HTTP $status"
  sleep 1
done
```

## Решения

### Вариант A: Прокси нестабилен (вероятный)
1. Обратиться к владельцу прокси (freemodel.dev) — сообщить о JSON parse ошибках
2. Добавить retry-логику в Claude Code — но это требует патча самого CC
3. Использовать другой прокси с лучшей совместимостью

### Вариант B: Прокси не поддерживает streaming
1. В `~/.claude/settings.json` попробовать:
   - Отключить streaming (если есть настройка)
   - Или использовать `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (уже стоит)

### Вариант C: Перейти на официальный API
- Купить Anthropic API credits
- Или использовать AWS Bedrock / Google Vertex как бэкенд
- Claude Code поддерживает: `CLAUDE_CODE_USE_BEDROCK=1` или `CLAUDE_CODE_USE_VERTEX=1`

### Вариант D: Обернуть прокси в корректирующий слой
Написать локальный middleware (Node.js) между Claude Code и прокси:
- Перехватывает невалидные ответы
- Возвращает Claude Code правильный JSON с ошибкой, а не мусор
- Автоматически ретраит при 5xx

Пример структуры:
```
Claude Code → localhost:3456 (middleware) → cc.freemodel.dev
```

## Рекомендация
Начать с Шага 1 (curl-тест). Это даст точный ответ что именно прокси возвращает.

## Файлы
- `~/.claude/settings.json` — конфигурация Claude Code (API ключ, base URL)
- `~/.claude/logs/` — логи (если есть)
