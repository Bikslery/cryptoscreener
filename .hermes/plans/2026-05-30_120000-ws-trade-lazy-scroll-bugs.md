# Plan: Fix 5 WS / Lazy-Scroll Bugs in ChartGrid.tsx

**Date:** 2026-05-30  
**File:** `client/src/components/charts/ChartGrid.tsx`  
**Related:** `client/src/services/candle-cache.ts`

---

## Goal

Fix five bugs causing candle data loss, visual glitches, and unnecessary work during real-time WebSocket streaming and lazy-scroll history loading.

---

## Bug 1 — useWsTrade does not write to cache or backing array (CRITICAL)

### Problem

`useWsCandle` (line 340–382) correctly:
1. Calls `candleCache.updateCandle(symbol, tf, c)`
2. Updates `candlesDataRef.current[last]` or pushes new candle
3. Then calls `flush.queueCandle(...)`

`useWsTrade` (line 384–428) does **none** of 1 or 2 — it only calls `flush.queueCandle(...)`.  
When `useLazyScroll` calls `setData()` with `candlesDataRef.current`, the trade-built candle is absent from that array. Result: the current unclosed candle "jumps backward" every time history is prepended.

### Fix

Add `candlesDataRef` parameter to `useWsTrade` (same pattern as `useWsCandle`), and inside the trade handler, after updating `cur`:

```ts
// After cur is updated:
candleCache.updateCandle(symbol, tf, cur as UnifiedCandle)
if (candlesDataRef?.current) {
  const arr = candlesDataRef.current
  const last = arr[arr.length - 1]
  if (last && last.time === cur.time) {
    arr[arr.length - 1] = cur as UnifiedCandle
  } else if (!last || cur.time > last.time) {
    arr.push(cur as UnifiedCandle)
  }
}
```

Also add `flush.queueVolume(...)` — `useWsTrade` currently only queues candle, not volume.

### Files to change
- `ChartGrid.tsx` — `useWsTrade` function signature + body, call site at line 912

---

## Bug 2 — Race condition: setData vs RAF update

### Problem

`useLazyScroll` calls `setData()` synchronously inside `getOrFetchOlder().then(...)`. Meanwhile, `useRafFlush` schedules `update()` on the next animation frame. If `setData()` fires between frames and then a previously-scheduled RAF `update()` runs against the pre-`setData` dataset, that single tick is lost. Rare but reproducible with fast scroll + high-frequency stream.

### Fix

Add a generation counter (`setDataGen`) to `useRafFlush`. When `useLazyScroll` calls `setData()`, it increments the counter. `useRafFlush.flush()` checks the counter before calling `update()`. If the counter changed since the RAF was scheduled, the stale `update()` is skipped and the pending data is re-queued for the next frame.

Alternatively (simpler, preferred): make `useLazyScroll` call `update()` instead of `setData()` when prepending. Iterate over only the newly added candles and call `update()` on each — this avoids the full `setData()` overwrite and makes the race moot. But this is a larger refactor and may be slower for 1000-bar prepends. 

**Recommended approach:** In `useLazyScroll`, after `setData()`, immediately drain the pending RAF state so the next frame has nothing stale to apply:

```ts
// After setData:
candleRef.current?.setData(candleData)
volumeRef.current?.setData(volumeData)
// Drain stale RAF — prevent it from updating with old data
cancelAnimationFrame(rafId.current)  // needs access to flush internals
```

**Simplest practical fix:** Export a `drain()` method from `useRafFlush` that immediately flushes pending updates and resets the RAF id. Call `flush.drain()` right before `setData()` in `useLazyScroll`. This ensures any pending WS update is applied first, and the subsequent `setData()` operates on the already-current chart.

### Files to change
- `ChartGrid.tsx` — `useRafFlush`: add `drain()` method
- `ChartGrid.tsx` — `useLazyScroll`: call `flush.drain()` before `setData()`

---

## Bug 3 — useLazyScroll does not debounce scroll events

### Problem

`subscribeVisibleLogicalRangeChange` fires on every pixel of scroll. `inflightRef` prevents parallel requests, but the `onRange` callback still executes on every event — running threshold math, cache lookups, etc. dozens of times per second during fast scroll.

### Fix

Add a simple leading-edge debounce (or throttle) on `onRange`:

```ts
const lastCheckRef = useRef(0)
const DEBOUNCE_MS = 150

const onRange = (range) => {
  if (!range || adjustingRef.current || inflightRef.current || reachedStartRef.current) return
  const now = Date.now()
  if (now - lastCheckRef.current < DEBOUNCE_MS) return
  lastCheckRef.current = now
  // ... rest of logic
}
```

Leading-edge ensures the first scroll event triggers immediately (low latency), subsequent events within 150ms are skipped.

### Files to change
- `ChartGrid.tsx` — `useLazyScroll`: add `lastCheckRef` + timestamp check

---

## Bug 4 — emptyCountRef irreversibly blocks lazy-load

### Problem

3 consecutive empty responses → `reachedStartRef = true` forever (until remount). If the server returns `[]` due to a transient error (network blip, temporary 500), history loading stops permanently for that symbol/tf.

### Fix

Reset `emptyCountRef` on symbol/tf change (already done at line 164) AND add a time-based cooldown instead of a permanent lock:

```ts
const reachedAtRef = useRef(0)
const REACHED_COOLDOWN_MS = 30_000  // 30 seconds

// In onRange, replace:
//   if (reachedStartRef.current) return
// with:
if (reachedStartRef.current) {
  if (Date.now() - reachedAtRef.current < REACHED_COOLDOWN_MS) return
  // Cooldown expired — give it another chance
  reachedStartRef.current = false
  emptyCountRef.current = 0
}
```

When `emptyCountRef >= 3`:
```ts
reachedStartRef.current = true
reachedAtRef.current = Date.now()
```

This way, after 30 seconds, the hook will try loading older history again.

### Files to change
- `ChartGrid.tsx` — `useLazyScroll`: replace permanent `reachedStartRef` with cooldown-based approach

---

## Bug 5 — useWsTrade uses `let cur` instead of useRef

### Problem

`let cur = null` at line 392 is scoped to the effect. On re-render (not remount), the closure preserves `cur`. But when `symbol` or `tf` changes, the effect re-runs, `cur = null`, and the unclosed candle is lost. During fast coin switching, the first tick of the new candle may be "empty" or cause a visual gap.

### Fix

Use `useRef` for `cur` so it survives re-renders, and reset it when `symbol`/`tf` change:

```ts
function useWsTrade(symbol, tf, flush, destroyedRef, candlesDataRef) {
  const curRef = useRef<UnifiedCandle | null>(null)

  useEffect(() => {
    curRef.current = null  // reset on symbol/tf change
    const tradeType = `trade:${symbol}`
    
    const unsub = wsOnType(tradeType, (msg) => {
      // ... same logic but use curRef.current instead of cur
      if (!curRef.current || curRef.current.time !== candleTime) {
        curRef.current = { time: candleTime, open: price, ... }
      } else {
        // update curRef.current.high / .low / .close / .volume
      }
      // cache + backing array update (Bug 1 fix)
      // flush.queueCandle + flush.queueVolume
    })
    wsSubscribe(tradeType)
    return () => { unsub(); wsUnsubscribe(tradeType) }
  }, [symbol, tf])
}
```

### Files to change
- `ChartGrid.tsx` — `useWsTrade`: replace `let cur` with `useRef`

---

## Implementation Order

1. **Bug 5** (let cur → useRef) — simplest, prerequisite for Bug 1
2. **Bug 1** (cache + backing array writes in useWsTrade) — critical data loss
3. **Bug 3** (debounce onRange) — simple, reduces wasted work
4. **Bug 4** (cooldown instead of permanent lock) — simple, prevents permanent dead-ends
5. **Bug 2** (flush.drain() before setData) — most subtle, needs careful testing

## Verification

- After Bug 1+5 fix: scroll back while receiving trades — unclosed candle should NOT jump backward
- After Bug 2 fix: rapid scroll + high-frequency stream — no missing ticks (visual test, hard to unit-test)
- After Bug 3 fix: scroll fast — DevTools Performance tab should show far fewer `onRange` calls
- After Bug 4 fix: disconnect network, scroll to trigger 3 empty responses, reconnect — history should load after ~30s cooldown
- After Bug 5 fix: switch coins rapidly — no blank first-tick candles

## Risks / Open Questions

- **Bug 2 drain approach:** calling `drain()` before `setData()` means the WS update is applied via `update()`, then immediately overwritten by `setData()`. This is safe because `setData()` uses `candlesDataRef` which now includes the trade-built candle (Bug 1 fix). But worth verifying that `update()` + `setData()` in the same synchronous block doesn't cause lightweight-charts to flicker.
- **Bug 4 cooldown:** 30s is a guess. If the server has longer outages, may need to be configurable or use exponential backoff.
- **flush.queueVolume in useWsTrade:** currently volume updates from trades are lost entirely — this is likely a separate unnoticed bug, but should be fixed alongside Bug 1.

## Summary of Files to Change

| File | Changes |
|------|---------|
| `client/src/components/charts/ChartGrid.tsx` | `useWsTrade` (Bugs 1, 5), `useRafFlush` (Bug 2), `useLazyScroll` (Bugs 3, 4), call site line 912 (Bug 1) |
