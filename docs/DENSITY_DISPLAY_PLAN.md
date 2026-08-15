# План: порт отображения плотностей из scalpboard.io в crypto-screener

> Этот документ — самодостаточный план для другой нейросети. Он содержит (1) полный разбор
> того, КАК устроены плотности на scalpboard.io (расшифровка из минифицированного JS),
> (2) gap-анализ того, что уже есть в этом репозитории, (3) пошаговый план реализации
> «как скопировать фичу и адаптировать под наш стек»: React 19 + lightweight-charts v5 +
> zustand + Tailwind v4. Ничего дословно не копируется — воспроизводится функциональность
> и математика, переписанная на наш стек.

---

## 0. Кратко: что за фича и что делаем

scalpboard.io — крипто-скринер для скальперов. Фича «плотности» (orderbook density walls) —
это **крупные лимитные заявки в стакане** (объёмы от сотен тысяч USDT), которые они
кластеризуют, категоризируют (Большие/Средние/Малые) и показывают:

1. **На графике цены** — каждая плотность рисуется как горизонтальная линия на уровне её
   цены, которая начинается в **момент рождения стены** (по оси времени) и тянется до правого
   края графика. Цвет: заявки на продажу (ask) — красный, на покупку (bid) — зелёный.
   Справа у края графика — плашка-подпись: `{мини-бейдж биржи} {размер} {цена}`.
2. **В меню/панели плотностей** — двумерная «карта»: по горизонтали 3 колонки-тира
   (Большие/Средние/Малые), по вертикали расстояние от текущей цены в процентах
   (аски сверху, биды снизу). Каждый блок — цветная плашка по hue монеты, с подписью
   `{тикер}` и `{кол-во объединённых} {суммарный объём}`. Есть зум (глубина), фильтры
   категорий, переключатель «объединять скопления в стены» (кластеризация).

**В итоге нужно сделать 3 вещи в нашем проекте:**
- **A.** Переписать оверлей плотностей на графике: линии от момента рождения стены до
  правого края (сейчас у нас — линии на всю ширину от x=0).
- **B.** Переписать панель `DensityMap.tsx` в двумерную карту-грид по тирам и расстоянию.
- **C.** Добавить клиентскую кластеризацию «стены» (объединение близких плотностей) +
  новую математику категорий (мультипликаторы БРП + минимальное время жизни на тир).

---

## 1. Референс: как это реализовано на scalpboard.io (расшифровка бандла)

Анализ проводился по минифицированным Nuxt-чанкам (`/_nuxt/*.js`). Ниже — вся механика,
которую нужно воспроизвести. Имена переменных наши (переименованы из минифицированных),
логика — точная.

### 1.1. Формат данных плотности (сырьё)

Денсити в их сторе хранится как массив из 4 чисел:

```
[price, size, age, distance]
   [0]    [1]    [2]    [3]
```

- `price` — цена стены;
- `size` — размер **в единицах**, ×1000 = USDT (`sizeUsdt = size * 1000`);
- `age` — **возраст стены** (в минутах; при рендере переводится в момент рождения);
- `distance` — **расстояние от текущей цены в процентах**.

Индекс доступа: `densities[ticker][market][side]` → массив таких записей, где
`side ∈ {'a' | 'b'}` (`a` = ask, `b` = bid).

Их клиент получает их по REST: `GET {BASE}/data/densities`, затем нормализует.
(У нас сервер уже шлёт готовые объекты `DensityWall`, см. §2 — данные не трогаем.)

### 1.2. Категории: тиры и `calcTier`

Категории (тиры) задаются массивом `tiers`, каждый элемент:

```
{ size: <мультипликатор БРП>, time: <мин. время жизни, мин.> , title: "large"|"medium"|"small" }
```

Порядок массива: `[0]=Large, [1]=Medium, [2]=Small` (по справке: «Большие (напр. 4),
Средние (напр. 2), Малые (напр. 1)» — от большего к меньшему).

Алгоритм `calcTier(ticker, market, density)` — возвращает номер тира (1..3) или `undefined`:

```
bds = getBaseDensitySize(ticker, market)          // БРП: см. §1.3
sizeUsdt = density[1] * 1000
age      = density[2]                              // минуты
for (i = 0; i < tiers.length; i++):
    {size: mult, time: lifetime} = tiers[i]
    if (age >= lifetime)          AND
       (sizeUsdt >= bds * mult):
        return i + 1
return undefined                                   // не дотянул даже до Small
```

Т.е. плотность «важна» только если она прожила достаточно долго (timeout по тиру) И её
размер превышает `БРП × мультипликатор тира`. Возвращается самая «старшая» (самая крупная)
категория, под которую она подходит (первый подходящий тир в массиве).

**Математика БРП (порог по объёму):**
```
threshold_large = БРП × multLarge
threshold_medium = БРП × multMedium
threshold_small = БРП × multSmall
```
Заявка ≥ порога тира — плотность этого тира. Авто-БРП считается «по объёму торгов монеты»
(у нас это уже есть на сервере — top-quartile медиана, см. §2).

### 1.3. БРП (Base Density Size) — базовый порог

Приоритет определения БРП для конкретной (ticker, market):
1. **Персональный override** из таблицы «Индивидуальная настройка» (`baseDensitySizes`), с
   флагом `hidden` (скрыть монету с карты);
2. Иначе **ручное значение** БРП (режим «Вручную» / `absolute`);
3. Иначе **авто-БРП** по объёму;
4. Фоллбэк по умолчанию: `5e5` (500 000 USDT).
   Код: `Math.max(minSizeByMarket, perSymbolOverride ?? manualSize ?? autoBds ?? 5e5)`.

Настройки БРП (их i18n-ключи, т.е. фактическое содержимое меню):
- `densities_size: { auto, absolute }` — режим «Авто» / «Вручную»;
- `manual_bds: "Значение"` — ручное значение БРП в долларах;
- `changedOnly: "Только измененные"` — фильтр таблицы переопределений;
- `base_density_sizes` — «Индивидуальная настройка» БРП по монетам (таблица ticker → сумма);
- `multiplicators_and_time_of_life: { multipliers: "Мультипликаторы БРП", lifetime: "Время жизни" }`.

### 1.4. Кластеризация в «стены» (`processedDensitiesWalls`)

Ключевая фича — **«Объединять скопления»** (`map.walls`, по умолчанию выключено).
Дефолты настроек карты: `{ showMarket: true, depth: 3, walls: false, wallsMaxSpread: 0.5,
wallsMinSize: 3, hideTradefiStocks: true, hideTradefiCommodities: true }`.

Алгоритм (точно, восстановлен из бандла):

```
for each (ticker, market, side) in densities:
    skip if ticker hidden / market disabled / в блок-листе
    sideDensities = densities[ticker][market][side]         // массив [price,size,age,distance]
    sort: asks по возрастанию цены, bids по убыванию цены
    // отфильтровать только те, что дотянули до тира
    tiered = []
    for d in sideDensities:
        t = calcTier(ticker, market, d)
        if t != undefined: tiered.push([...d, t])           // tier становится 5-м элементом
    if tiered пуст: continue

    // жадная кластеризация: соседние по цене в пределах spread% — один кластер
    clusters = []
    current  = [tiered[0]]
    for i in 1..len:
        if withinSpread(tiered[i-1].price, tiered[i].price, wallsMaxSpread):
            current.push(tiered[i])                          // тот же кластер
        else:
            closeCluster(current); current = [tiered[i]]
    closeCluster(current)

    // закрытие кластера: если >= wallsMinSize элементов → «стена», иначе → одиночная плотность
    for each cluster:
        if cluster.length >= wallsMinSize:
            wallTier = min over cluster of density[4]        // тир стены = минимальный тир (самая крупная категория)
            push { type:"wall", ticker, side, market, density: [[price,size,age,distance]...], tier: wallTier, distance: cluster[0][3] }
        else:
            for each d in cluster:
                push { type:"density", ticker, side, market, density: [price,size,age,distance], tier: d[4], distance: d[3] }

где withinSpread(c, l, pct) = |c - l| / min(c, l) * 100 <= pct
```

Итог: список записей `type: "wall" | "density"`. `wall.density` — массив всех объединённых
плотностей; `wall.tier` — минимальный тир среди членов (визуально стену тянет влево,
к колонке крупной категории); `wall.distance` — расстояние первой (ближайшей) плотности.

UI настроек кластеризации (слайдеры):
- `wallsMaxSpread` — «Макс. расстояние между плотностями»: `min=0.1, max=3, step=0.05`, формат `<={x}%`, дефолт `0.5`;
- `wallsMinSize` — «Мин. количество плотностей»: `min=2, max=5, step=1`, формат `>={x}`, дефолт `3`.

### 1.5. Рендер на графике цены

Плотности на графике — это набор объектов `labled_line` (их собственный тип фигуры),
добавляемых слоем поверх свечей. Для каждой плотности:

```
nowSec = Date.now()/1000 - serverTimeOffset         // «текущее время сервера» в секундах
birthTimeSec = nowSec - age * 60                    // МОМЕНТ РОЖДЕНИЯ стены
price = density.price * (chartDenomination / density.denomination)   // деноминация (мультипликатор цены)
label = `${markets[market].mini} ${formatUsdt(size)} ${price.toFixed(precision)}`
     // напр. "BI-F 4.5M 68123.5"; market.mini = "BI-S"|"BI-F"|"BY-S"|"BY-F"|"OK-S"|"OK-F"
baseline = side === "b" ? "top" : "bottom"           // биды — подпись сверху, аски — снизу
colorScheme = "density"                              // определяет цвет линии
drawPrice = false                                    // цену не показывать (только по ховеру)
ghostly = true                                       // не перехватывать мышь
```

**Рендерер `labled_line`** (их код, восстановлен дословно-по-смыслу):

```
if нет координат или x начала за пределами правого края: return []   // стена «умерла»/не видна
// позиция плашки по X:
labelW = label.length * 6 + 8 + 8
p = (lastDataX + 32 + labelW) < chartWidth ? chartWidth - labelW : lastDataX + 32
// baseline/цвет:
baseline = extend.baseline ?? (lastDataTime > birthTime ? "top" : "bottom")
color = baseline === "top" ? upColor : downColor     // из схемы "density"
// рисуем:
1) горизонтальная ЛИНИЯ от (x=birthX, y=priceY) до (x=p, y=priceY)  — цвет color
2) квадратик-маркер 3×3 в точке рождения (x=birthX-1, y=priceY-1)
3) плашка-текст у x=p: текст label, baseline, шрифт 10px mono, weight 300,
   фон color+20 (20 = hex alpha), рамка color 1px, padding 4/4/3/4
4) (опционально, только при ховере) плашка с ценой у x=birthX
```

Цвета схемы `density` берутся из CSS-переменных темы:
- `--chart--density-up: #c74343` (красный) — аски;
- `--chart--density-down: #43c743` (зелёный) — биды;
- маппинг: `upColor = --chart--density-down` (зелёный), `downColor = --chart--density-up`
  (красный), и для `baseline === "top"` берётся `upColor` (зелёный = bid), для
  `baseline === "bottom"` — `downColor` (красный = ask).

**Ключевая визуальная идея:** линия начинается на оси времени в момент рождения стены и
тянется вправо до края. Пока стена живёт — линия «растёт»; когда стена исчезает из стакана —
она исчезает целиком (вместе со своей «историей»). Это отличается от нашего текущего
оверлея (линия на всю ширину от x=0, т.е. рисуется даже для ещё не родившихся стен на
старой истории).

### 1.6. Панель плотностей (двумерная карта)

Компонент `AppMapDensity` + `Wall`. Раскладка:

- **Две зоны по вертикали**: верхняя — аски (`direction === "a"`), нижняя — биды (`"b"`).
  Между ними — линия текущей цены.
- **Колонки по тирам**: каждая зона делится на 3 колонки (Large/Medium/Small).
  Горизонтальная позиция блока:
  ```
  colW = 100 / tiers.length            // 100/3 ≈ 33.33%
  left = colW * tier - colW/2          // tier=1 → 16.67%, tier=2 → 50%, tier=3 → 83.33%
  ```
  (стены с минимальным тиром прижаты к левому краю — крупнейшая категория).
- **Вертикальная позиция по расстоянию** (внутри своей зоны):
  ```
  y = distance > depth ? (скрыть блок) : distance / depth * 100   // в %
  ```
  где `depth` («Глубина», по умолчанию 3%, диапазон 0.5..10%) — видимое окно в %
  от цены. Аски позиционируются через CSS `bottom: y%`, биды — через `top: y%`.
- **Цвет блока** — hue монеты (`claimHue`), через HSL:
  ```
  hue = golden angle: index * 137.508 % 360   (с шагом; палитра до 512 монет)
  lOffset = случайное 0..min(step, 24)
  color = hsla(hue, 40%, (dark ? 70 : 40) - lOffset, 0.9)
  ```
- **Содержимое блока-стены**: `<span>{ticker}</span><span>{count} {formatUsdt(sum)}</span>`,
  где `count = densities.length`, `sum = Σ density[1]*1000` (суммарный объём USDT всех
  объединённых). Для одиночной плотности — те же поля (count=1).
- **Взаимодействия**:
  - hover → `focusedDensity = {ticker, market, density, densities}` (подсветка блока классом `active`);
  - клик → переход на график этой монеты (в нашем проекте — `expandChartAtPrice(symbol, price)`).
- **Зум-глубина**: `shift + колесо` меняет `depth` на ±0.5 (clamp 0.5..10); тач — драг
  по вертикали (`delta/25 * 0.5`).
- **Легенда категорий** внизу: строка из 3 колонок с подписями `map.small / map.medium /
  map.large` («Малые / Средние / Большие»).
- **Фильтры/настройки** (панель настроек):
  - чекбоксы показа категорий: `map.small`, `map.medium`, `map.large`;
  - чекбокс `map.showMarket` — «Показывать с какой биржи плотность»;
  - чекбокс `map.walls` — «Объединять скопления»;
  - слайдеры `wallsMaxSpread`, `wallsMinSize` (см. §1.4).

### 1.7. Настройки (полный набор, их словарь)

Из i18n-бандла (ключи → русские подписи):
- `charts.showDensities` — «Показывать плотности» (слой на графике);
- `densities_size: auto|absolute`, `manual_bds`, `changedOnly`, `base_density_sizes`,
  `multiplicators_and_time_of_life.{multipliers,lifetime}`;
- `map.{depth, small, medium, large, showMarket, walls}`;
- `settings.wallsMaxSpread` («Макс. расстояние между плотностями»), `settings.wallsMinSize`
  («Мин. количество плотностей»);
- `markets` — 6 рынков (Binance/Bybit/OKX × spot/perp) с включением и коэффициентом
  коррекции объёма `size` (влияет на авто-БРП);
- `mutedTickers.densities` — скрытие монет именно из раздела плотностей;
- `baseDensitySizes[ticker].hidden` — скрытие монеты с карты плотностей.

---

## 2. Gap-анализ: что уже есть в нашем репозитории

### 2.1. Сервер (уже готово, не трогаем)

`server/src/services/density/index.ts` уже реализует **движок плотностей**:
- кластеризация стакана в бакеты 0.05% от mid (`STEP_PCT = 0.0005`), `clusterSide()`;
- детекция локальных максимумов выше порога (`detectWalls`), top-K на сторону;
- «рождение» стены с `bornAt` (первый тик пересечения порога), экспирация, если не
  увидели в следующем тике;
- `roundNumber` — признак круглой цены (`isRoundPrice`);
- авто-БРП: перминутная запись max-кластера в кольцевой буфер 24ч, порог — медиана
  верхней квартили (`computeAutoBrp`), дефолт БРП `300000`, `MIN_MULT = 2`;
- снапшот `DensitySnapshot { ts, walls: DensityWall[], autoBrps }`, WS-броадкаст каждые
  `BROADCAST_MS = 2000` мс, REST `GET /api/density?limit=N` (routes/density.ts);
- `WallState` с `lastSeenTick` для экспирации.

`DensityWall` уже содержит: `symbol, exchange, side('bid'|'ask'), price, sizeUsdt, bornAt,
roundNumber`. Т.е. **все данные для рендера уже есть** — включая `bornAt` (нужен для
линии от момента рождения).

### 2.2. Клиент — данные (готово)

- `client/src/store/density.ts` — zustand-стор: подписка WS на канал `density`, REST
  bootstrap, хранит `walls[]`, `autoBrps[]`, `ts`.
- `client/src/services/density.ts` — утилиты:
  - `DEFAULT_DENSITY_SETTINGS`: `{ mode:'auto', manualBrp:300_000, multSmall:2,
    multMedium:3.5, multLarge:5, perSymbol:{}, zoomPct:5 }`;
  - `resolveDensitySettings(patch)`, `effectiveBrp()`, `categorizeSize()`,
    `toDensityCell()`, `autoBrpMap()`, `formatUsdt()`, `formatAge()`;
  - `EXCHANGE_BADGE` и `EXCHANGE_COLOR` — бейджи «BI-S/BI-F/BY-F/OK-S/OK-F» (совпадают с
    их `markets.*.mini`!) и цвета бирж.
- Типы в `client/src/types.ts` (§~240-320): `DensityWall`, `DensitySnapshot`,
  `DensitySettings`, `DensityCell`, `DensitySymbolBrp` — уже есть.

### 2.3. Клиент — отображение (частично, нужно переделывать)

- **График**: `client/src/components/charts/overlays/DensityPrimitive.ts` +
  `useDensityOverlay.ts` — уже рисует горизонтальные линии на ценах стен + плашку справа.
  **Отличия от scalpboard** (что менять):
  - сейчас линия от `x=0` до правого края → надо **от момента рождения стены** до края;
  - сейчас цвет по категории (серый/жёлтый/красный) → надо **по направлению**
    (bid зелёный / ask красный);
  - сейчас подпись `{бейдж} {размер} {возраст}` → надо `{бейдж} {размер} {цена}`;
  - сейчас baseline `ask→bottom, bid→top` — совпадает, оставляем.
- **Панель**: `client/src/components/density/DensityMap.tsx` — сейчас это «лесенка»
  (ladder) одной монеты по вертикали + список топ-60 глобальных стен. **Нужно переписать**
  в двумерную карту по тирам (как scalpboard) ИЛИ добавить вторую вкладку. Решение о UX —
  см. §3.
- **Настройки**: `client/src/components/auth/ProfileModal.tsx` (секция Density) — уже есть:
  режим авто/вручную, ручной БРП, мультипликаторы, per-symbol overrides, `zoomPct`.
  **Нужно добавить**: время жизни на тир, переключатель «объединять скопления»,
  слайдеры wallsMaxSpread/wallsMinSize, глубину карты, чекбоксы категорий, showMarket.

---

## 3. Целевая архитектура (карта «фича → файл → действие»)

| Фича | Где | Действие |
|---|---|---|
| A. Линии от рождения стены + новые цвета/подпись | `overlays/DensityPrimitive.ts`, `useDensityOverlay.ts` | Переписать рендер + прокинуть `bornAt`/birth time |
| B. Карта плотностей 2D | `density/DensityMap.tsx` (+ возможно новый компонент) | Переписать/добавить грид по тирам и расстоянию |
| C. Кластеризация «стены» | новый `services/density-cluster.ts` или в `services/density.ts` | Реализовать `processedDensitiesWalls` |
| C. Категории + время жизни | `services/density.ts`, `types.ts` | Новые поля settings + `calcTier`-аналог |
| D. Настройки UI | `auth/ProfileModal.tsx` | Добавить контролы (§5) |
| E. Палитра hue монет | новый `utils/claimHue.ts` | Golden-angle палитра |
| F. Скрытие монет на карте | `services/density.ts`, types | `perSymbol.hidden` / мьют из плотностей |

**Решение UX по панели (важно — спросить/решить):** scalpboard-карта — глобальная
(все монеты), в отличие от нашей лесенки (одна монета). Варианты:
- (Рекомендуется) **оставить** `DensityMap.tsx` как есть (лесенка по выбранной монете) и
  **добавить** новую вкладку/панель «Карта плотностей» с двумерным гридом по всем монетам;
- либо заменить лесенку картой полностью. Рекомендую первое — не ломаем существующее.

---

## 4. Пошаговая реализация

### Шаг 1. Типы и настройки (`client/src/types.ts`)

Расширить `DensitySettings` (сейчас: `mode, manualBrp, multSmall, multMedium, multLarge,
perSymbol, zoomPct`):

```ts
export interface DensitySettings {
  mode: 'auto' | 'manual'
  manualBrp: number
  multSmall: number
  multMedium: number
  multLarge: number
  /** мин. время жизни (минуты) на категорию, чтобы плотность попала в неё */
  lifeSmall: number
  lifeMedium: number
  lifeLarge: number
  perSymbol: Record<string, number>
  zoomPct: number                      // глубина карты, 0.5..10, дефолт 3 (у нас сейчас 5)
  walls: boolean                       // объединять скопления (дефолт false)
  wallsMaxSpread: number               // 0.1..3, дефолт 0.5
  wallsMinSize: number                 // 2..5, дефолт 3
  showMarket: boolean                  // показывать биржу-источник (дефолт true)
  showSmall: boolean                   // фильтр категорий на карте (дефолт true)
  showMedium: boolean
  showLarge: boolean
  hiddenSymbols: string[]              // скрытые с карты монеты (или флаг hidden в perSymbol)
}
```

Обновить `DEFAULT_DENSITY_SETTINGS` в `services/density.ts`:
```ts
{
  mode: 'auto', manualBrp: 300_000,
  multSmall: 2, multMedium: 3.5, multLarge: 5,
  lifeSmall: 0, lifeMedium: 0, lifeLarge: 0,     // пока 0 = без ограничения
  perSymbol: {}, zoomPct: 5, walls: false,
  wallsMaxSpread: 0.5, wallsMinSize: 3,
  showMarket: true, showSmall: true, showMedium: true, showLarge: true,
  hiddenSymbols: [],
}
```

### Шаг 2. Категоризация с временем жизни (`services/density.ts`)

Добавить аналог их `calcTier` (возвращает тир 1..3 или undefined) поверх существующих
`effectiveBrp`/`categorizeSize`:

```ts
export type Tier = 1 | 2 | 3   // 1=Large, 2=Medium, 3=Small

export function calcTier(
  wall: DensityWall,
  settings: DensitySettings,
  autoBrp: number | null,
  now = Date.now(),
): Tier | undefined {
  const brp = effectiveBrp(wall.symbol, settings, autoBrp)
  const ageMin = (now - wall.bornAt) / 60000
  const tiers: { mult: number; life: number }[] = [
    { mult: settings.multLarge, life: settings.lifeLarge },
    { mult: settings.multMedium, life: settings.lifeMedium },
    { mult: settings.multSmall, life: settings.lifeSmall },
  ]
  for (let i = 0; i < tiers.length; i++) {
    const { mult, life } = tiers[i]
    if (ageMin >= life && wall.sizeUsdt >= brp * mult) return (i + 1) as Tier
  }
  return undefined
}
```

> У нас `bornAt` — абсолютное время рождения в мс (сервер уже шлёт). Это **лучше** их
> подхода `now - age*60`: не нужен сдвиг часов клиента/сервера.

### Шаг 3. Кластеризация в стены (новый `services/density-cluster.ts`)

Точный перенос алгоритма §1.4. Вход: `walls: DensityWall[]` + настройки. Выход:
`(DensityWall & { tier: Tier })[]` или массив записей `{ type:'wall'|'density', wall, tier,
members: DensityWall[] }`.

```ts
export interface DensityItem {
  type: 'wall' | 'density'
  wall: DensityWall          // для density — сама стена; для wall — первая (ближайшая)
  tier: Tier
  members: DensityWall[]     // у wall — все объединённые; у density — [wall]
}

export function clusterDensities(
  walls: DensityWall[],
  settings: DensitySettings,
  autoBrpMap: Map<string, number | null>,
  priceOf: (symbol: string) => number,
): DensityItem[] {
  // 1) сгруппировать по `${symbol}:${exchange}:${side}`, отсортировать по цене
  //    (bids по убыванию, asks по возрастанию — как в §1.4)
  // 2) в каждой группе отфильтровать по calcTier (undefined → выбросить)
  // 3) жадная кластеризация по withinSpread(price, price, wallsMaxSpread)
  // 4) кластер >= wallsMinSize → wall (tier = min tier участников, wall = первый участник)
  //    иначе → отдельные density-элементы
  // 5) вернуть объединённый список
}

function withinSpread(a: number, b: number, pct: number): boolean {
  return Math.abs(a - b) / Math.min(a, b) * 100 <= pct
}
```

Примечание: `wall.members` нужен для суммы на карте (`Σ sizeUsdt` по всем объединённым)
и для счётчика `count`.

### Шаг 4. Палитра hue монет (новый `client/src/utils/claimHue.ts`)

```ts
const GOLDEN = 137.508
export function claimHue(symbol: string, seedIndex: number): { hue: number; lOffset: number } {
  const hue = (seedIndex * GOLDEN) % 360
  const lOffset = Math.min(seedIndex % 25, 24)   // упрощение их random(0..min(step,24))
  return { hue, lOffset }
}
export function wallColor(hue: number, lOffset: number, isDark: boolean): string {
  const base = isDark ? 70 : 40
  return `hsla(${hue},40%,${Math.max(0, base - lOffset)}%,0.9)`
}
```

### Шаг 5. Рендер на графике (A) — `overlays/DensityPrimitive.ts` + `useDensityOverlay.ts`

**Идея:** сейчас `DensityLineSpec` содержит только `price`. Добавить `birthTime` (unix-сек),
`price` (уже есть), `color`, `text`, `baseline`. В рендерере:

```ts
interface DensityLineSpec {
  price: number
  birthTimeSec: number      // момент рождения стены (wall.bornAt / 1000)
  color: string
  text: string
  baseline: 'top' | 'bottom'
}
```

В `_draw` (уже есть `useMediaCoordinateSpace`):
- `y0 = series.priceToCoordinate(s.price)` — как сейчас;
- `x0 = chart.timeScale().timeToCoordinate(s.birthTimeSec as Time)` — **НОВОЕ**;
- если `x0 === null` → стена родилась вне видимого диапазона (слева) → **скип** (не рисуем).
  > ВНИМАНИЕ: lightweight-charts `timeToCoordinate` возвращает `null` для времени вне
  > загруженных данных. Для времени «в будущем» (нет бара) координата может быть `null`.
  > Альтернатива, если скип слишком агрессивен: для `birthTime` раньше первого бара —
  > не рисовать (корректно: стена «умерла», её история не нужна); для будущего — не
  > должно случаться (bornAt ≤ now).
- `rightX = width - labelW` (или `lastDataX + 32`, см. формулу §1.5 — но нам проще
  `width - labelW`, как в текущем коде);
- линия от `(x0, y0)` до `(rightX, y0)` — `ctx.moveTo(x0, y0+.5); ctx.lineTo(rightX, y0+.5)`;
- маркер 3×3 в `(x0-1, y0-1)`; плашка текста у `x=rightX` (логика плашки — как сейчас,
  `withAlpha(color, 0.12)` фон, рамка, текст 10px).

Обновить `useDensityOverlay.ts`:
- брать `wall.bornAt` → `birthTimeSec = wall.bornAt / 1000`;
- цвет: по `wall.side`:
  ```ts
  const color = wall.side === 'bid' ? 'var(--chart--density-down, #43c743)' : 'var(--chart--density-up, #c74343)'
  ```
  Либо захардкодить `#43c743` / `#c74343` (в проекте нет этих CSS-переменных — см. Шаг 7,
  где их добавить в `index.css`).
- подпись: `${EXCHANGE_BADGE[wall.exchange]} ${formatUsdt(wall.sizeUsdt)} ${wall.price.toFixed(pricePrecision)}`
  (убрать возраст, добавить цену);
- `baseline` — как сейчас (`ask → bottom`, `bid → top`);
- **важно**: фильтр по времени — не рисовать стены, чей `bornAt` в будущем (`bornAt > Date.now()`).

Оставить пока текущий «полноширинный» режим как фоллбэк? Нет — заменяем целиком, это
и есть порт фичи. (Если нужно сохранить категорийные цвета — см. §7 «улучшения».)

### Шаг 6. Карта плотностей (B) — `DensityMap.tsx`

Переписать компонент (или создать `DensityGrid.tsx` и смонтировать из `RightPanel.tsx`
рядом с существующим). Структура:

```
<div class="relative flex-1">                    // контейнер карты
  // 2 зоны: верхняя (asks) и нижняя (bids), разделённые линией mid
  // внутри каждой зоны 3 колонки-тира
  // колонки: позиционирование по left = colW*tier - colW/2 (%)
  // блок: top/bottom = distance/depth*100 (%), цвет wallColor(hue)
  // содержимое блока (wall): {ticker} {count} {formatUsdt(sum)}
</div>
```

Данные: взять `items = clusterDensities(walls, settings, autoBrps, price)` из Шага 3,
отфильтровать по `settings.showLarge/Medium/Small` и `settings.showMarket`, скрыть
`settings.hiddenSymbols`. Группировать по `(symbol, exchange, side)`.

Позиционирование (следуем §1.6):
```
colW = 100 / 3
left = colW * tier - colW/2                       // %
yPct = Math.min(100, Math.max(0, distance / depth * 100))
// ask: style={{ bottom: `${yPct}%`, left: `${left}%` }}
// bid: style={{ top:    `${yPct}%`, left: `${left}%` }}
```
где `distance` — `distancePct` из `toDensityCell` (уже считает расстояние от текущей цены).

Зум: `shift+wheel` → `zoomPct ± 0.5`, clamp `[0.5, 10]`; сохранение в настройки (у нас уже
есть `onWheelZoom` в текущем коде — перенести). Тач — по желанию.

Hover → локальный `focusedDensity` (подсветка `.active`), клик → `expandChartAtPrice(symbol,
price)` (уже есть в сторе). Легенда категорий — 3 колонки снизу.

**UX-решение:** сохранить текущую «лесенку» (Ladder) как отдельную вкладку или в верхней
части, а карту добавить ниже/рядом. См. §3. Минимально-инвазивный вариант: внутри
`DensityMap.tsx` сделать два режима (`tab === 'ladder' | 'grid'`) либо просто заменить
`Ladder` на `DensityGrid` и оставить список «Все плотности».

### Шаг 7. CSS-переменные тем (`client/src/index.css`)

Добавить переменные, как у scalpboard (тёмная тема):
```css
:root {
  --chart--density-up: #c74343;     /* ask */
  --chart--density-down: #43c743;   /* bid */
  --map--top: #c74343;              /* карта: верх/аски */
  --map--bottom: #43c743;           /* карта: низ/биды */
}
```
(Если в проекте несколько тем — добавить в каждую.)

### Шаг 8. UI настроек — `ProfileModal.tsx`

В секции Density (строки ~1020-1140) добавить:
- три поля «Время жизни» (мин) — `lifeSmall/Medium/Large` (числовые инпуты, как у
  мультипликаторов);
- чекбокс «Объединять скопления» — `walls`;
- при `walls === true` — два слайдера: `wallsMaxSpread` (0.1..3, шаг 0.05, подпись
  `<={x}%`) и `wallsMinSize` (2..5, шаг 1, подпись `>={x}`);
- слайдер/инпут «Глубина карты» — `zoomPct` (0.5..10);
- чекбоксы показа категорий — `showLarge/Medium/Small`;
- чекбокс «Показывать биржу» — `showMarket`;
- сохранение через существующий `saveDensity` (debounce уже есть).

### Шаг 9. (Опц.) Скрытие монет с карты

- В `ProfileModal` таблицу per-symbol добавить чекбокс/кнопку «скрыть с карты» →
  записывать в `settings.density.hiddenSymbols` (или флаг `hidden` в perSymbol);
- В `DensityMap` фильтровать `hiddenSymbols`; в `useDensityOverlay` — тоже (скрытые не
  рисуем на графике).

### Шаг 10. Проверка и тесты

- `client`: `npm run lint`, `npm run test` (есть `vitest`; для `DensityMap` уже есть
  тесты/`App.test.tsx` мок стора — обновить).
- Добавить unit-тесты на чистые функции: `calcTier` (пороги + возраст), `clusterDensities`
  (2 соседние в пределах spread → wall; 1 → density), `claimHue` (детерминированность),
  `withinSpread`.
- Ручная проверка: сервер (`server`, `npm run dev`) → клиент (`client`, `npm run dev`) →
  развернуть график, включить «Показывать плотности», убедиться: линии от рождения до
  края; зелёные биды снизу/красные аски сверху; подписи «BI-F 4.5M 68123.5»; в панели —
  карта по тирам и расстоянию, зум shift+колесо, фильтры категорий, «объединять скопления».

---

## 5. Контрольные константы (сводка для точного воспроизведения)

| Величина | Значение | Источник |
|---|---|---|
| БРП по умолчанию | 300 000 USDT (у нас) / 500 000 (у них) | наши настройки |
| Мультипликаторы | Small 2, Medium 3.5, Large 5 (у нас); у них примеры 4/2/1, 6/4/2 | настройки |
| Время жизни (мин) | настраивается, у нас дефолт 0 (нет ограничения) | Шаг 2 |
| `wallsMaxSpread` | 0.1..3, дефолт 0.5, шаг 0.05 | §1.4 |
| `wallsMinSize` | 2..5, дефолт 3, шаг 1 | §1.4 |
| `depth` (глубина карты) | 0.5..10, дефолт 3 (у нас 5), шаг зума 0.5 | §1.6 |
| Цвета density | ask `#c74343`, bid `#43c743` | §1.5 |
| Бейджи бирж | BI-S, BI-F, BY-S, BY-F, OK-S, OK-F | §1.5, совпадает с нашим |
| Hue палитра | golden angle 137.508° | §1.6 |
| Цвет блока карты | `hsla(hue,40%,(70|40)-lOffset,0.9)` | §1.6 |
| Формат подписи графика | `{бейдж} {size} {price.toFixed(precision)}` | §1.5 |
| Формат подписи стены на карте | `{ticker}` + `{count} {formatUsdt(sum)}` | §1.6 |

---

## 6. Порядок работ и зависимости

1. **Шаг 1-2** (типы + calcTier) — фундамент, всё остальное зависит.
2. **Шаг 3** (clusterDensities) — чистые функции, можно сразу покрыть тестами.
3. **Шаг 5** (оверлей графика) — самый заметный визуальный эффект, требует только Шаг 1.
4. **Шаг 6** (карта) — зависит от Шага 3 (данные) и Шага 4 (цвета).
5. **Шаги 7-9** (CSS, настройки, скрытие) — UI-полировка, независимы.
6. **Шаг 10** — тесты и регресс.

> Рекомендация исполнителю: делать инкрементально, каждый шаг — компилируемым
> (`tsc -b` / `npm run lint` в `client`). Не коммитить без явной просьбы.

---

## 7. Что можно улучшить сверх копии (наши преимущества)

1. **Возраст из `bornAt` без сдвига часов** — у нас сервер шлёт абсолютное `bornAt`, у них
   `now - age` с офсетом часов. Надёжнее.
2. **Линии с прозрачностью по возрасту** — старые стены полупрозрачные (у них нет).
3. **Экспоненциальная/логарифмическая шкала расстояния** на карте вместо линейной —
   плотные около цены, разреженные дальше.
4. **Слияние категорийного цвета с направлением** — сейчас у нас цвет = категория, у них =
   направление. Можно: цвет линии = направление (как у них), а толщина/прозрачность =
   категория.
5. **Per-market включение плотностей** (их `enabledDensitiesMarkets` + коррекция объёма)
   — у нас сервер шлёт по топ-N; добавить фильтр бирж на клиенте.
6. **hover-тултип** на линии с полным разбором (цена, размер, возраст, биржа) — у них
   только price-плашка при ховере.
