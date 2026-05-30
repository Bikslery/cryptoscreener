# Plan: Fix 5 WS / Lazy-Scroll Bugs (v2 — updated priorities)

**Date:** 2026-05-30  
**File:** `client/src/components/charts/ChartGrid.tsx`  
**Related:** `client/src/services/candle-prefetch.ts`, `client/src/services/candle-cache.ts`

---

## Goal

Fix five bugs in ChartGrid.tsx causing candle data loss, visual glitches, and unnecessary work during real-time WebSocket streaming and lazy-scroll history loading.

---

## P0 — Bug 1: useWsTrade does not write to cache or backing array

### Current code (line 384–428)

`useWsTrade` only calls `flush.queueCandle(...)`. It does NOT call:
- `candleCache.updateCandle(symbol, tf, c)`
- `candlesDataRef.current[last] = c` or `arr.push(c)`

`useWsCandle` (line 353–362) does both correctly.

### Consequence

When `useLazyScroll` calls `setData()` with `candlesDataRef.current`, the trade-built candle is absent. Current unclosed candle "jumps backward" on every history prepend.

### Fix

1. Add `candlesDataRef` param to `useWsTrade` signature (same as `useWsCandle`)
2. After updating `cur`, add cache + backing array writes:
```ts
candleCache.updateCandle(symbol, tf, cur)
if (candlesDataRef?.current) {
  const arr = candlesDataRef.current
  const last = arr[arr.length - 1]
  if (last?.time === cur.time) arr[arr.length - 1] = { ...cur }
  else arr.push({ ...cur })
}
```
3. Also add `flush.queueVolume(...)` — currently missing entirely (volume from trades never rendered)
4. Update call site at line 912: `useWsTrade(symbol, tf, flush, destroyedRef, candlesDataRef)`

### Files
- `ChartGrid.tsx` — `useWsTrade` function + call site

---

## P0 — Bug 2: Race condition — setData vs RAF update

### Problem

`useLazyScroll` calls `setData()` synchronously (line 262–263). `useRafFlush` calls `update()` on the next animation frame. If `setData` fires mid-frame, a previously-scheduled RAF `update()` applies to the old dataset, then `setData` overwrites it. Result: one tick lost. Rare but reproducible with fast scroll + high-frequency stream.

### Fix (per user spec)

Add `adjustingRef` guard to `useWsCandle` / `useWsTrade` — while `useLazyScroll` is doing `setData()`, skip WS updates (or buffer them for after).

Implementation:
1. Lift `adjustingRef` out of `useLazyScroll` — create it in the main chart component, pass it down to both `useWsCandle`, `useWsTrade`, and `useLazyScroll`
2. In `useWsCandle` handler, add early return: `if (adjustingRef?.current) return` — lightweight-charts `update()` during `setData` is wasteful anyway; the next RAF after `adjustingRef = false` will pick up the latest candle
3. Same guard in `useWsTrade`
4. `useLazyScroll` sets `adjustingRef.current = true` before `setData()`, resets to `false` after (already does this at line 250/277, but ref needs to be shared)

**Alternative (if skip is too aggressive):** buffer the WS update in `useRafFlush` while `adjustingRef.current === true`, apply it on the next frame after `adjustingRef` goes false. But skip is simpler and safe — `setData()` with `candlesDataRef` (now including trade-built candle via Bug 1 fix) already has the latest data.

### Files
- `ChartGrid.tsx` — `adjustingRef` created in main component, passed to `useWsCandle`, `useWsTrade`, `useLazyScroll`; early-return guards in WS handlers

---

## P1 — Bug 3: useLazyScroll does not debounce scroll events

### Problem

`subscribeVisibleLogicalRangeChange` fires on every pixel. `inflightRef` blocks parallel requests but not the threshold checks. Fast scroll = dozens of no-op `onRange` calls/sec.

### Fix (per user spec)

```ts
const debouncedOnRange = useMemo(() => debounce(onRange, 50), [symbol, tf])
ts.subscribeVisibleLogicalRangeChange(debouncedOnRange)
```

Needs a `debounce` utility. Options:
- Add `lodash.debounce` (npm dep) — overkill for one function
- Write a 5-line `debounce` in `utils/format.ts` or a new `utils/debounce.ts`

Recommended: write minimal `debounce`:
```ts
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, ms)
  }) as T
}
```

Note: trailing-edge debounce (above) means the check fires 50ms AFTER last scroll event. This is correct — we want to load only when scroll settles near the edge. Leading-edge would trigger too early during momentum scroll.

Also add cleanup: `return () => { ts.unsubscribeVisibleLogicalRangeChange(debouncedOnRange) }` (already exists but needs the debounced ref).

### Files
- New: `client/src/utils/debounce.ts`
- `ChartGrid.tsx` — `useLazyScroll`: wrap `onRange` with debounce, import

---

## P1 — Bug 4: emptyCountRef irreversibly blocks lazy-load

### Problem

3 consecutive empty responses → `reachedStartRef = true` forever. But `getOrFetchOlder` catches ALL errors as `[]` (line 108 of candle-prefetch.ts: `.catch(() => [])`). A server 500 or network timeout returns `[]`, indistinguishable from "genuinely no more data". The hook permanently stops loading.

### Fix (per user spec)

Differentiate "no data" (200 + empty array) from "error" (5xx/timeout). Only increment `emptyCountRef` on genuine "no data".

Implementation:
1. Change `getOrFetchOlder` to throw on HTTP errors instead of returning `[]`:
```ts
export function getOrFetchOlder(symbol: string, tf: string, before: number, limit: number = 1000): Promise<UnifiedCandle[]> {
  const k = inflightKey(symbol, tf, before)
  const existing = inflightMap.get(k)
  if (existing) return existing

  const promise = api.get(`/coins/${symbol}/candles`, { params: { tf, limit, before } })
    .then(res => (res.data as UnifiedCandle[]) || [])
    // Do NOT catch here — let the error propagate
    .finally(() => inflightMap.delete(k))

  inflightMap.set(k, promise)
  return promise
}
```

2. In `useLazyScroll`, handle `.catch()` separately:
```ts
getOrFetchOlder(curSymbol, curTf, before, 1000)
  .then(older => {
    // ... same logic, emptyCountRef only increments here (genuine empty)
  })
  .catch(() => {
    // Server error — do NOT increment emptyCountRef
    // Do NOT set reachedStartRef
    inflightRef.current = false
    setIsLoadingMore?.(false)
  })
```

This way, transient errors don't permanently block lazy-load. Only 3 genuine "no more data" responses lock it.

### Files
- `candle-prefetch.ts` — `getOrFetchOlder`: remove `.catch(() => [])`
- `ChartGrid.tsx` — `useLazyScroll`: add `.catch()` handler that doesn't increment `emptyCountRef`

---

## P2 — Bug 5: useWsTrade uses `let cur` instead of useRef

### Problem

`let cur = null` (line 392) is scoped to the effect closure. On symbol/tf change, effect re-runs, `cur = null`, unclosed candle is lost. Fast coin switching → "empty" first tick.

### Fix

```ts
const curRef = useRef<UnifiedCandle | null>(null)

useEffect(() => {
  curRef.current = null  // reset on symbol/tf change
  const tradeType = `trade:${symbol}`
  // ... same logic but use curRef.current instead of cur
  // if (!curRef.current || curRef.current.time !== candleTime) {
  //   curRef.current = { ... }
  // } else {
  //   if (price > curRef.current.high) curRef.current.high = price
  //   ...
  // }
```

This is naturally combined with Bug 1 fix since both change `useWsTrade`.

### Files
- `ChartGrid.tsx` — `useWsTrade`: `let cur` → `useRef`

---

## Implementation Order

1. **Bug 5 + Bug 1** (combined — same function, `useWsTrade` rewrite)
   - `let cur` → `useRef`
   - Add `candlesDataRef` param + cache/backing writes
   - Add `flush.queueVolume`
   - Update call site
2. **Bug 2** (adjustingRef guard in WS handlers)
   - Lift `adjustingRef` to main component
   - Add early-return in `useWsCandle` / `useWsTrade`
3. **Bug 3** (debounce)
   - Create `utils/debounce.ts`
   - Wrap `onRange` in `useLazyScroll`
4. **Bug 4** (error vs empty differentiation)
   - Change `getOrFetchOlder` to not swallow errors
   - Add `.catch()` in `useLazyScroll`

---

## Verification

| Bug | Test |
|-----|------|
| 1 | Scroll back while receiving trades — unclosed candle must NOT jump backward |
| 2 | Rapid scroll + high-frequency stream — no missing ticks |
| 3 | Fast scroll — DevTools shows `onRange` fires at most every ~50ms, not per-pixel |
| 4 | Kill server, scroll to trigger 3 empty responses, restart server — history loads again |
| 5 | Switch coins rapidly — no blank first-tick candles |

## Risks / Open Questions

- **Bug 2 skip approach:** skipping WS `update()` during `adjustingRef === true` means 1–2 frames of visual staleness during `setData`. Acceptable since `setData` immediately replaces all data including the latest trade-built candle (Bug 1 fix ensures this). If flicker is visible, switch to buffering approach.
- **Bug 3 trailing debounce:** 50ms delay means scroll-to-edge has 50ms latency before fetch starts. Acceptable tradeoff vs. dozens of no-op calls. Adjust ms if too sluggish.
- **Bug 4 remove `.catch(() => [])`:** any existing callers of `getOrFetchOlder` that don't handle rejection will crash. Need to verify no other callers. Currently only `useLazyScroll` calls it — safe.
- **Bug 4 alternative:** instead of removing catch, could return a tagged result `{ data: UnifiedCandle[], isError: boolean }`. But this is more invasive — simple catch removal is cleaner.

## Summary of Files to Change

| File | Bugs | Changes |
|------|------|---------|
| `client/src/components/charts/ChartGrid.tsx` | 1,2,3,5 | `useWsTrade` rewrite, `adjustingRef` lift + guards, debounce in `useLazyScroll` |
| `client/src/services/candle-prefetch.ts` | 4 | `getOrFetchOlder`: remove `.catch(() => [])` |
| `client/src/utils/debounce.ts` (new) | 3 | Minimal debounce utility |
