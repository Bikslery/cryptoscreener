# Plan: Fix Lazy Scroll + Add Current Price Line

## Goal
1. Fix lazy scroll — scrolling left in chart doesn't load older candles
2. Add horizontal dashed price line at current price, color changes green/red based on direction

## Root Cause Analysis — Lazy Scroll Bugs

### Bug 1: `fetchCandlesSeamless` logic is broken
**File:** `server/src/services/aggregator/index.ts` line 295

```js
if (coveredCount < remaining + coveredCount) {
```

This is `coveredCount < coveredCount + remaining` — ALWAYS true when `remaining > 0`. So the code always enters the "exchange didn't return full range" branch, even when it DID return the full range. The break condition `Got full range` (line 302) is never reached.

**Fix:** The condition should be `candles.length < limit_requested_from_this_adapter`. When an adapter returns fewer candles than requested, that means data ran out on this exchange → try next exchange with endTime = earliest candle time - 1 interval.

### Bug 2: `getHistory` `before` time boundary off-by-one
**File:** `server/src/services/candles/history.ts` line 259, 300

```js
const beforeMs = before ? before * 1000 - 1 : Date.now()
// ...
const filtered = sorted.filter(c => c.time * 1000 <= beforeMs)
```

Client sends `before = cached[0].time` (seconds). The `-1` makes it `before * 1000 - 1`, so the first candle's time (`before * 1000`) would pass the filter `c.time * 1000 <= beforeMs` → `before * 1000 <= before * 1000 - 1` → FALSE. So the oldest cached candle is EXCLUDED from server response, which is correct (avoid duplicate). But the `chunkKeysFor` function starts at `beforeMs` and goes backwards, so chunk boundaries are computed from `before * 1000 - 1`. This might miss a chunk boundary.

Actually this is OK — the filter removes duplicates. The real problem is elsewhere.

### Bug 3: `useLazyScroll` trigger condition `range.from > 20` too aggressive
**File:** `client/src/components/charts/ChartGrid.tsx` line 176

```js
if (range.from > 20) return
```

`range.from` is a logical range index (bar index from left). With 150 visible bars and `from: lastBar - 150`, `from` will be ~850 when you have 1000 candles. The user needs to scroll to bar index < 20 to trigger a load. But when `useFullHistory` loads 1000 candles and shows last 150, the leftmost visible bar is at index ~850. User must scroll 830 bars left to reach index 20 — that's a LOT of scrolling before anything triggers.

**Fix:** Use a threshold based on distance from the start of available data. E.g. trigger when `range.from < 50` (near left edge) — same concept but the key issue is the from/to values are logical bar indices, not pixel positions. Actually the real check should be: when the left edge of visible range is close to the start of data. A better approach: subscribe to visible range change, and when `from < threshold`, fetch older data.

Wait — re-reading: `range.from` is the logical index of the leftmost visible bar. When chart first loads with 1000 candles showing last 150, `from ≈ 850`. As user scrolls left, `from` decreases. When `from` reaches 20, the fetch triggers. This IS correct behavior — you need to scroll near the left edge.

But there's a subtler bug: after `useFullHistory` calls `setData` and sets `setVisibleLogicalRange({ from: lastBar - 150, to: lastBar + 5 })`, the chart re-renders. The `subscribeVisibleLogicalRangeChange` fires with the initial range, which has `from ≈ 850`, so `from > 20` is true and it returns early. This is fine. The user scrolls left, `from` decreases, eventually hits < 20, fetch triggers.

The REAL problem: after fetching older data, the code calls `setData` (full replacement) and then `setVisibleLogicalRange({ from: prevRange.from + added, to: prevRange.to + added })`. This shifts the viewport to account for prepended bars. But then the `subscribeVisibleLogicalRangeChange` fires AGAIN because the range changed, and `range.from` is now `prevRange.from + added` which is large → no re-trigger. Good, that's fine.

### Bug 4 (THE MAIN BUG): `getOrFetchOlder` doesn't cache result
**File:** `client/src/services/candle-prefetch.ts` line 101-113

```js
export function getOrFetchOlder(symbol, tf, before, limit) {
  const promise = api.get(`/${symbol}/candles`, { params: { tf, limit, before } })
    .then(res => (res.data as UnifiedCandle[]) || [])
    .catch(() => [])
}
```

This fetches older candles but does NOT put them into `candleCache`. The result is returned, and `useLazyScroll` calls `candleCache.prependCandles()`, which IS correct. So this isn't the bug.

### Bug 5 (THE REAL BUG): `before` is `cached[0].time` which is in SECONDS, but the route parses it as-is
**File:** `client/src/components/charts/ChartGrid.tsx` line 189

```js
const before = cached[0].time
```

`cached[0].time` is in seconds (Unix timestamp). This is sent as `?before=1748563200`. Server receives it as `parseInt(req.query.before)` → `1748563200`. Then `getHistory` does `before * 1000 - 1` → `1748563199999` ms. This is correct.

**But** the `fetchChunkSeamless` function (line 143-170) calls:
```js
const candles = await fetchCandlesSeamless(symbol, tf, CHUNK_SIZE, exchange, chunkStartMs, chunkEndMs, { dispatcher })
```

`chunkStartMs` and `chunkEndMs` are in MILLISECONDS. `fetchCandlesSeamless` passes them to `adapter.fetchCandles(symbol, tf, remaining, currentStart, currentEnd)`. The Binance adapter expects `startTime` and `endTime` in MILLISECONDS (sets them as URL params `startTime`/`endTime`). Binance API expects milliseconds. So this is correct.

### Bug 6 (ACTUAL ROOT CAUSE): `fetchCandlesSeamless` remaining calculation broken
Back to Bug 1 — the `remaining` logic:

```js
let remaining = limit  // e.g. 1000

for (const adapter of ordered) {
  const candles = await adapter.fetchCandles(symbol, tf, remaining, currentStart, currentEnd, options)
  // adapter returns max 1000 candles (MAX_KLINES_LIMIT)
  
  const coveredCount = candles.length
  remaining -= coveredCount  // remaining = 1000 - 1000 = 0 if full
  
  if (coveredCount < remaining + coveredCount) {  // 1000 < 0 + 1000 → FALSE
    // This means: if adapter returned fewer than we asked for
    // But the condition is WRONG
  }
}
```

Wait, let me re-check. After `remaining -= coveredCount`:
- If adapter returned 1000 candles: `remaining = 0`, condition `1000 < 0 + 1000` → `1000 < 1000` → FALSE → enters `else` → breaks (correct, got full range)
- If adapter returned 500 candles: `remaining = 500`, condition `500 < 500 + 500` → `500 < 1000` → TRUE → tries next exchange (correct, data ran out)

Actually... the logic works for the simple case. Let me re-read more carefully.

After `remaining -= coveredCount`:
- `remaining` = how many MORE candles we need
- `coveredCount` = how many this exchange gave us
- `remaining + coveredCount` = how many we ASKED this exchange for (which was the old `remaining` value)
- So condition is: `candles.length < old_remaining` → "did this exchange give us fewer than we asked for?"

This IS correct! If adapter gave us fewer than we asked, data ran out on this exchange, try next one.

BUT — there's still a problem. When we try the next exchange, we set:
```js
currentEnd = (earliestTime * 1000 - tfMs) / 1000
```

This converts to seconds, then `adapter.fetchCandles` expects `startTime`/`endTime` in MILLISECONDS. But `currentEnd` is now in SECONDS. When passed to `fetchCandles(symbol, tf, remaining, currentStart, currentEnd)`, the adapter sends `endTime=${currentEnd}` which is in seconds, not milliseconds! Binance expects milliseconds.

**THIS IS THE BUG.** The `currentEnd` and `currentStart` variables mix units — milliseconds on first call, seconds on subsequent calls.

Actually wait — let me re-check. The initial call is `fetchCandlesSeamless(symbol, tf, limit, exchange, startTime, endTime)` where `startTime`/`endTime` come from `fetchChunkSeamless` in milliseconds. On first adapter call, `currentStart = startTime` (ms), `currentEnd = endTime` (ms). OK.

After first adapter returns, `currentEnd = (earliestTime * 1000 - tfMs) / 1000` — this is now in SECONDS. But `currentStart` is still in milliseconds from the original call. Mixed units!

Then on the next adapter call: `adapter.fetchCandles(symbol, tf, remaining, currentStart, currentEnd)` — `currentStart` is ms, `currentEnd` is seconds. Binance will get confused.

**Fix:** Keep `currentEnd` in milliseconds consistently:
```js
currentEnd = earliestTime * 1000 - tfMs  // keep in ms
```

### Bug 7: `useLazyScroll` — `range.from` comparison assumes bar index starts at 0
When `useFullHistory` sets data and then `setVisibleLogicalRange`, lightweight-charts assigns logical indices starting from 0. So the first candle is at index 0, second at 1, etc. `range.from` is the logical index of the leftmost visible bar.

After scroll-left fetch: the code prepends `added` bars and shifts visible range via `from: prevRange.from + added, to: prevRange.to + added`. This is correct.

But the `range.from > 20` threshold: when there are 1000 candles, leftmost visible bar is at index ~850. User scrolls left until `from < 20`. With 150 visible bars, they'd see bars 0-150 when from=0. But from=20 means they're very close to the start. This seems fine.

**Actually the threshold might be the problem on smaller datasets.** If initial fetch returns only 50 candles, visible range might be `from: 0, to: 55`. `range.from = 0 < 20` → triggers immediately on mount! And `inflightRef` prevents double-fire. But the initial `useFullHistory` sets `isInitialLoading = true`, and `useLazyScroll` returns early if `isInitialLoading`. Once loading completes, the subscription fires with `from ≈ 0` → immediate fetch for older data. This could work... but might cause issues.

Let me check: `useLazyScroll` is subscribed on `[symbol, tf, isInitialLoading]`. When `isInitialLoading` becomes false, the effect re-runs, creating a new subscription. At that point, the chart already has data visible, so `from` should be > 20 (showing the last 150 bars out of 1000). This seems fine.

## Summary of Root Causes

1. **CRITICAL: `fetchCandlesSeamless` mixes ms/seconds for `currentEnd`** — after first adapter returns, `currentEnd` is converted to seconds but `currentStart` stays in ms. Binance adapter sends wrong `endTime` to API → returns 0 candles → looks like "no more data" → `useLazyScroll` gets empty array → `reachedStartRef` set → stops trying.

2. **`fetchCandlesSeamless` `remaining` logic is actually OK** — re-analysis shows it works correctly.

3. **Minor: emptyCountRef >= 2 may give up too quickly** — if seamless stitching fails once, second attempt also returns empty (due to Bug 1), so reachedStart is set prematurely.

## Step-by-Step Plan

### Step 1: Fix `fetchCandlesSeamless` unit mismatch
**File:** `server/src/services/aggregator/index.ts`

Change line 298:
```js
// BEFORE (broken — converts to seconds):
currentEnd = (earliestTime * 1000 - tfMs) / 1000

// AFTER (keep in ms, consistent with startTime/endTime contract):
currentEnd = earliestTime * 1000 - tfMs
```

Also add `currentStart` adjustment for second exchange:
```js
// When trying next exchange, set startTime = undefined (fetch as far back as possible)
// and endTime = just before earliest candle from previous exchange
currentStart = undefined  // let the next exchange give us as much history as it has
currentEnd = earliestTime * 1000 - tfMs  // ms
```

Also fix the condition to be clearer:
```js
const requestedFromAdapter = remaining + coveredCount  // what we asked for
if (candles.length < requestedFromAdapter) {
  // adapter returned fewer than requested — data ends on this exchange
  currentEnd = earliestTime * 1000 - tfMs  // ms
  currentStart = undefined
} else {
  break  // got all data we needed
}
```

Wait — that's the same logic just expressed differently. The bug is purely the unit mismatch.

### Step 2: Fix `fetchCandlesSeamless` — clear `currentStart` on second exchange
When falling back to next exchange, `currentStart` should be undefined so the adapter fetches as far back as it can. Keeping the original `startTime` restricts the second exchange to the same start boundary.

### Step 3: Add logging to `useLazyScroll` for debugging
Add `console.log` on fetch trigger and result to help verify fix works. Remove after testing.

### Step 4: Add current price line
**File:** `client/src/components/charts/ChartGrid.tsx`

Use lightweight-charts `ISeriesApi` with `LineSeries` or use chart price line API:
- `candleSeries.createPriceLine({ price, color, lineStyle: 2 /* Dashed */, lineWidth: 1 })`
- Update on every WS trade/candle update
- Color: green (#26a65b) when price goes up, red (#e74c3c) when price goes down
- Track previous price to determine direction

Implementation in `ExpandedChart` component:
1. After chart creation, create a price line: `candleRef.current.createPriceLine({...})`
2. Store priceLine ref
3. On each WS trade update, update the price line price and color
4. Use `ISeriesApi<...>.removePriceLine()` + `createPriceLine()` to update (lightweight-charts doesn't support in-place update of price line properties, need to recreate)
5. Actually lightweight-charts v4+ has `priceLine.applyOptions()` on the returned object from `createPriceLine()`

Let me check the API:
```ts
const priceLine = series.createPriceLine({
  price: 123.45,
  color: '#26a65b',
  lineStyle: 2, // Dashed
  lineWidth: 1,
  axisLabelVisible: true,
  title: '',
})
// To update:
priceLine.applyOptions({ price: newPrice, color: newColor })
```

This is the clean approach.

### Step 5: Clean up `useLazyScroll` — lower threshold or make it adaptive
Current threshold `range.from > 20` means user must scroll very close to the start. This might feel unresponsive. Consider increasing the trigger distance:
```js
if (range.from > 50) return  // trigger earlier
```

Or better: trigger when visible range is within N bars of data start:
```js
const dataLength = candlesDataRef.current.length
const triggerThreshold = Math.max(50, Math.floor(dataLength * 0.1))
if (range.from > triggerThreshold) return
```

## Files to Change

1. **`server/src/services/aggregator/index.ts`** — Fix `fetchCandlesSeamless` currentEnd unit (ms not seconds), clear currentStart on fallback
2. **`client/src/components/charts/ChartGrid.tsx`** — Add price line in ExpandedChart, adjust lazy scroll threshold, add price line update in useWsTrade/useWsCandle
3. **`server/src/services/candles/history.ts`** — No changes needed (units are consistent within this file)

## Verification

1. Start server + client
2. Open a chart, scroll left — older candles should load
3. Check browser console for lazy scroll fetch logs
4. Verify price line appears, follows current price, changes color on direction change
5. Verify no duplicate candles in chart
6. Run `npx tsc --noEmit` for both server and client

## Risks / Tradeoffs

- Price line recreation on every tick could cause flicker — use `applyOptions()` instead
- `currentStart = undefined` on fallback means the second exchange might return candles that overlap with what we already have — dedup by time handles this
- Removing `currentStart` restriction means more data from secondary exchange, but also more API weight — acceptable tradeoff for working lazy scroll
