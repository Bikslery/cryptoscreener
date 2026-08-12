import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import type { UnifiedTicker, Timeframe, ChartBlock, Exchange, Alert as AlertType, UserSettings } from '../types.js'
import { wsOnMessage, wsOnType, wsSubscribe, wsUnsubscribe } from '../services/ws.js'
import { notifyNewAlert } from '../services/alert-notify.js'
import { emitAlertRemoved } from '../services/alert-drawing-sync.js'
import { getOrFetchHistory, EXPANDED_CANDLE_LIMIT } from '../services/candle-prefetch.js'
import api from '../services/api.js'
import { VOLUME_HIGH_THRESHOLD, VOLUME_FILTER_DEFAULT } from '../constants/volume.js'

export type ChartExchange = 'binance-spot' | 'binance-futures' | 'bybit-futures'

const CHART_EXCHANGE_STORAGE_KEY = 'serotonin.chartExchange'
const VALID_CHART_EXCHANGES: ChartExchange[] = ['binance-spot', 'binance-futures', 'bybit-futures']
const DEFAULT_CHART_EXCHANGE: ChartExchange = 'binance-futures'

function readStoredChartExchange(): ChartExchange {
  if (typeof window === 'undefined') return DEFAULT_CHART_EXCHANGE
  try {
    const raw = window.localStorage.getItem(CHART_EXCHANGE_STORAGE_KEY)
    if (raw && (VALID_CHART_EXCHANGES as string[]).includes(raw)) {
      return raw as ChartExchange
    }
  } catch { /* ignore */ }
  return DEFAULT_CHART_EXCHANGE
}

const EXCHANGE_PRIORITY: Record<Exchange, number> = {
  'binance-futures': 5,
  'bybit-futures': 4,
  'okx-spot': 3,
  'okx-futures': 3,
  'binance-spot': 2,
}

function dedup(coins: UnifiedTicker[]): UnifiedTicker[] {
  const map = new Map<string, UnifiedTicker>()
  for (const c of coins) {
    const existing = map.get(c.symbol)
    if (!existing || EXCHANGE_PRIORITY[c.exchange] > EXCHANGE_PRIORITY[existing.exchange]) {
      map.set(c.symbol, c)
    }
  }
  return Array.from(map.values())
}

/**
 * Sort a deduped coin list by the active column, with WATCHLIST symbols
 * pinned to the top. Both groups follow the same comparator — the top of the
 * list is always the user's favourites in the current sort order, and the
 * rest of the list is unchanged by the pinning.
 */
function sortCoins(
  coins: UnifiedTicker[],
  sortBy: keyof UnifiedTicker,
  sortDir: 'asc' | 'desc',
  watchlist: string[],
): UnifiedTicker[] {
  const watched = new Set(watchlist)
  const cmp = (a: UnifiedTicker, b: UnifiedTicker) => {
    const dir = sortDir === 'desc' ? -1 : 1
    const aVal = a[sortBy] ?? 0
    const bVal = b[sortBy] ?? 0
    if (typeof aVal === 'string' && typeof bVal === 'string') return dir * aVal.localeCompare(bVal)
    return dir * ((aVal as number) - (bVal as number))
  }
  const pinned: UnifiedTicker[] = []
  const rest: UnifiedTicker[] = []
  for (const c of dedup(coins)) (watched.has(c.symbol) ? pinned : rest).push(c)
  pinned.sort(cmp)
  rest.sort(cmp)
  return [...pinned, ...rest]
}


function buildCoinMap(coins: UnifiedTicker[]): Map<string, UnifiedTicker> {
  const m = new Map<string, UnifiedTicker>()
  for (const c of coins) m.set(c.symbol, c)
  return m
}

/**
 * Merge an incoming ticker batch into the master per-exchange list using
 * identity preservation: unchanged entries keep their object reference (so
 * memoized rows/charts don't re-render), changed entries are replaced.
 *
 * Entries are keyed by `${symbol}:${exchange}` — a delta carries one entry per
 * exchange, and a spot update must NEVER overwrite the futures entry (or vice
 * versa). Deduping by symbol here would pick whichever exchange changed last
 * (often spot) and clobber the other exchanges' entries, which made volumes
 * and precision flicker between spot/futures values. Brand-new (symbol,
 * exchange) pairs are appended so listings don't wait for the next snapshot.
 * Exported for unit tests.
 */
export function mergeTickerBatch(
  list: UnifiedTicker[],
  updates: UnifiedTicker[],
): { next: UnifiedTicker[]; dirty: boolean } {
  const updateMap = new Map<string, UnifiedTicker>()
  for (const c of updates) updateMap.set(`${c.symbol}:${c.exchange}`, c)

  const existingKeys = new Set<string>()
  let dirty = false
  const next = list.map((c) => {
    const key = `${c.symbol}:${c.exchange}`
    existingKeys.add(key)
    const u = updateMap.get(key)
    if (!u) return c
    if (u.price === c.price && u.change24h === c.change24h && u.quoteVolume24h === c.quoteVolume24h) return c
    dirty = true
    return u
  })
  // New (symbol, exchange) pairs not in the master list yet (new listings).
  for (const [key, u] of updateMap) {
    if (!existingKeys.has(key)) {
      next.push(u)
      dirty = true
    }
  }
  return { next, dirty }
}

// Rebuild the deduped view (sortedCoins + coinMap) from the per-exchange
// master list, keeping the previous sort ORDER stable and only updating
// entries / appending newly-listed chartExchange symbols. The full re-sort
// happens on snapshots.
function rebuildDedupedView(
  state: { sortedCoins: UnifiedTicker[]; chartExchange: ChartExchange },
  raw: UnifiedTicker[],
): Partial<CoinListStore> {
  const deduped = dedup(raw)
  const bySymbol = new Map<string, UnifiedTicker>()
  for (const d of deduped) bySymbol.set(d.symbol, d)

  const seen = new Set<string>()
  const newSorted: UnifiedTicker[] = []
  for (const c of state.sortedCoins) {
    if (seen.has(c.symbol)) continue
    seen.add(c.symbol)
    const u = bySymbol.get(c.symbol)
    // Only swap in the same-exchange entry — the sorted list is scoped to the
    // active chartExchange; a foreign-exchange entry would mislabel the row.
    newSorted.push(u && u.exchange === c.exchange ? u : c)
  }
  for (const d of deduped) {
    if (seen.has(d.symbol) || d.exchange !== state.chartExchange) continue
    seen.add(d.symbol)
    newSorted.push(d)
  }
  return {
    coins: raw,
    sortedCoins: newSorted,
    coinMap: buildCoinMap(newSorted),
  }
}

/**
 * Apply a ticker frame (delta or snapshot) to the store state.
 * - Delta: per-exchange identity-preserving merge (fast path, no re-sort) +
 *   deduped view rebuild so coinMap/sortedCoins always hold the highest-
 *   priority exchange entry per symbol.
 * - Snapshot (or the first message on connect): full replace + recompute
 *   (re-sort, pageCount clamp, coinMap rebuild). Exported for unit tests.
 */
export function applyTickerFrame(
  state: { coins: UnifiedTicker[]; sortedCoins: UnifiedTicker[]; coinMap: Map<string, UnifiedTicker>; autoRefresh: boolean; sortBy: keyof UnifiedTicker; sortDir: 'asc' | 'desc'; chartExchange: ChartExchange; minVolume24h: number; pageIndex: number; watchlist: string[] },
  coins: UnifiedTicker[],
  isDelta: boolean,
): Partial<CoinListStore> {
  const merged = mergeTickerBatch(state.coins, coins)

  if (!state.autoRefresh) {
    // Auto-refresh off: patch prices in place; never re-sort or replace
    // wholesale (the visible order stays frozen by design).
    if (!merged.dirty) return {}
    return rebuildDedupedView(state, merged.next)
  }

  if (isDelta) {
    if (!merged.dirty) return {}
    return rebuildDedupedView(state, merged.next)
  }

  // Full snapshot (initial connect or periodic) — replace + recompute.
  return { coins, ...recompute({ ...state, coins }) }
}

const VOLUME_FILTER_MIN = 0
const VOLUME_FILTER_MAX = VOLUME_HIGH_THRESHOLD
const VOLUME_FILTER_STORAGE_KEY = 'serotonin.minVolume24h'

const WATCHLIST_STORAGE_KEY = 'serotonin.watchlist'
const WATCHLIST_MAX = 200

function readStoredWatchlist(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, WATCHLIST_MAX)
  } catch {
    return []
  }
}

function persistWatchlist(list: string[]) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

function readStoredMinVolume(): number {
  if (typeof window === 'undefined') return VOLUME_FILTER_DEFAULT
  try {
    const raw = window.localStorage.getItem(VOLUME_FILTER_STORAGE_KEY)
    if (!raw) return VOLUME_FILTER_DEFAULT
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) return VOLUME_FILTER_DEFAULT
    return Math.max(VOLUME_FILTER_MIN, Math.min(VOLUME_FILTER_MAX, parsed))
  } catch {
    return VOLUME_FILTER_DEFAULT
  }
}

interface CoinListStore {
  coins: UnifiedTicker[]
  sortedCoins: UnifiedTicker[]
  coinMap: Map<string, UnifiedTicker>
  sortBy: keyof UnifiedTicker
  sortDir: 'asc' | 'desc'
  selectedSymbol: string | null
  expandedSymbol: string | null
  activeTimeframe: Timeframe
  chartExchange: ChartExchange
  minVolume24h: number
  /** Symbols pinned to the top of the list (persisted to localStorage). */
  watchlist: string[]
  pageIndex: number
  pageCount: number
  autoRefresh: boolean
  countdown: number
  setSort: (col: keyof UnifiedTicker) => void
  selectCoin: (symbol: string) => void
  expandChart: (symbol: string | null) => void
  setTimeframe: (tf: Timeframe) => void
  setChartExchange: (ce: ChartExchange) => void
  setMinVolume24h: (v: number) => void
  setPageIndex: (n: number) => void
  toggleWatch: (symbol: string) => void
  toggleAutoRefresh: () => void
  tickCountdown: () => void
  init: () => () => void
}

function filterByChartExchange(coins: UnifiedTicker[], ce: ChartExchange): UnifiedTicker[] {
  return coins.filter(c => c.exchange === ce)
}

function filterByMinVolume(coins: UnifiedTicker[], minVolume24h: number): UnifiedTicker[] {
  if (!minVolume24h || minVolume24h <= 0) return coins
  return coins.filter(c => (c.quoteVolume24h ?? 0) >= minVolume24h)
}

function recompute(state: { coins: UnifiedTicker[]; sortBy: keyof UnifiedTicker; sortDir: 'asc' | 'desc'; chartExchange: ChartExchange; minVolume24h: number; pageIndex: number; watchlist: string[] }) {
  const byExchange = filterByChartExchange(state.coins, state.chartExchange)
  const filtered = filterByMinVolume(byExchange, state.minVolume24h)
  const sorted = sortCoins(filtered, state.sortBy, state.sortDir, state.watchlist)
  const pageCount = Math.max(1, Math.ceil(sorted.length / 9))
  const safePage = Math.min(Math.max(0, state.pageIndex), pageCount - 1)
  return { sortedCoins: sorted, coinMap: buildCoinMap(sorted), pageCount, pageIndex: safePage }
}

// --- Live price store (decoupled from the heavy CoinListStore) ----------------
// Trade WS messages update per-symbol prices via a tiny pub/sub. Components
// that need live price use `useLivePrice(symbol)` and only re-render when
// THEIR symbol's price changes — no array clones, no global cascade.

const livePrices = new Map<string, number>()
const livePriceListeners = new Map<string, Set<() => void>>()

// --- Live-price publisher: fixed cadence (default 500 ms). --------------
// All realtime sources (bookTicker mid, trades, ticker deltas, forming-candle
// livePrice) funnel into setLivePrice. Instead of forwarding EVERY change (on
// active symbols that is dozens of times per second), the visible price is
// sampled: the LATEST value per symbol is published at most once per interval.
// The very first price for a symbol is published immediately so the first
// paint is instant; everything after that within the window coalesces into a
// single step. The stored API (getLivePrice / useLivePrice / subscribeLivePrice)
// is unchanged, so all consumers (CoinList cells, gliding headers) automatically
// step at the fixed cadence.
let LIVE_PRICE_INTERVAL_MS = 500
const pendingPrices = new Map<string, number>()
const lastPublishAt = new Map<string, number>()
let pendingTimer: ReturnType<typeof setTimeout> | null = null

/** Tune the cadence (min 50 ms). Tests and runtime settings can call this. */
export function setLivePriceInterval(ms: number): void {
  LIVE_PRICE_INTERVAL_MS = Math.max(50, Number.isFinite(ms) ? ms : 500)
}

/** Synchronously publish every pending price (tests / imperative flush). */
export function flushLivePrices(): void {
  if (pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null }
  const now = Date.now()
  for (const [symbol, price] of pendingPrices) {
    lastPublishAt.set(symbol, now)
    commitLivePrice(symbol, price)
  }
  pendingPrices.clear()
}

/** Wipe all live-price state incl. batching (tests only). */
export function resetLivePriceStore(): void {
  if (pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null }
  pendingPrices.clear()
  lastPublishAt.clear()
  livePrices.clear()
  livePriceListeners.clear()
}

export function subscribeLivePrice(symbol: string, listener: () => void): () => void {
  let set = livePriceListeners.get(symbol)
  if (!set) { set = new Set(); livePriceListeners.set(symbol, set) }
  set.add(listener)
  return () => {
    const s = livePriceListeners.get(symbol)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) livePriceListeners.delete(symbol)
  }
}

/** Current live price for a symbol (imperative read — no React re-render). */
export function getLivePrice(symbol: string): number | undefined {
  return livePrices.get(symbol)
}

function commitLivePrice(symbol: string, price: number) {
  const prev = livePrices.get(symbol)
  if (prev === price) return
  livePrices.set(symbol, price)
  const set = livePriceListeners.get(symbol)
  if (set) for (const l of set) l()
}

function scheduleSweep(ms: number) {
  if (pendingTimer !== null) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    sweepPendingPrices()
  }, ms)
}

function sweepPendingPrices() {
  const now = Date.now()
  let nextIn = LIVE_PRICE_INTERVAL_MS
  const ready: Array<[string, number]> = []
  for (const [symbol, price] of pendingPrices) {
    const since = now - (lastPublishAt.get(symbol) ?? 0)
    if (since >= LIVE_PRICE_INTERVAL_MS) {
      ready.push([symbol, price])
      pendingPrices.delete(symbol)
      lastPublishAt.set(symbol, now)
    } else {
      nextIn = Math.min(nextIn, LIVE_PRICE_INTERVAL_MS - since)
    }
  }
  for (const [symbol, price] of ready) commitLivePrice(symbol, price)
  if (pendingPrices.size > 0) scheduleSweep(Math.max(1, nextIn))
}

export function setLivePrice(symbol: string, price: number) {
  if (!Number.isFinite(price) || price <= 0) return
  const since = Date.now() - (lastPublishAt.get(symbol) ?? -Infinity)
  if (since >= LIVE_PRICE_INTERVAL_MS) {
    // Enough wall-time since this symbol's last publish (or its first price):
    // commit NOW so the first paint is instant and updates follow the cadence.
    lastPublishAt.set(symbol, Date.now())
    commitLivePrice(symbol, price)
    return
  }
  // Within the window — coalesce the latest value; the sweep publishes it at
  // the cadence boundary (latest-wins, so bursts become a single step).
  pendingPrices.set(symbol, price)
  scheduleSweep(LIVE_PRICE_INTERVAL_MS - since)
}

export function useLivePrice(symbol: string): number | undefined {
  return useSyncExternalStore(
    (cb) => subscribeLivePrice(symbol, cb),
    () => livePrices.get(symbol),
    () => livePrices.get(symbol),
  )
}

export const useCoinListStore = create<CoinListStore>((set, get) => ({
  coins: [],
  sortedCoins: [],
  coinMap: new Map(),
  sortBy: 'quoteVolume24h',
  sortDir: 'desc',
  selectedSymbol: null,
  expandedSymbol: null,
  activeTimeframe: '5m',
  chartExchange: readStoredChartExchange(),
  minVolume24h: readStoredMinVolume(),
  watchlist: readStoredWatchlist(),
  pageIndex: 0,
  pageCount: 1,
  autoRefresh: true,
  countdown: 10,

  toggleAutoRefresh: () => set((s) => ({
    autoRefresh: !s.autoRefresh,
    countdown: !s.autoRefresh ? 10 : 0,
  })),

  tickCountdown: () => {
    const s = get()
    if (!s.autoRefresh) return
    const next = s.countdown - 1
    if (next <= 0) {
      set({ countdown: 10 })
      // Trigger re-sort
      set({ coins: s.coins, ...recompute({ ...s, coins: s.coins }) })
    } else {
      set({ countdown: next })
    }
  },

  setSort: (col) => {
    const s = get()
    const targetCol: keyof UnifiedTicker = col === 'symbol' ? 'quoteVolume24h' : col
    const newDir: 'asc' | 'desc' = s.sortBy === targetCol && s.sortDir === 'desc' ? 'asc' : 'desc'
    const next = { sortBy: targetCol, sortDir: newDir, pageIndex: 0 }
    set({ ...next, ...recompute({ ...s, ...next }) })
  },

  selectCoin: (symbol) => set({ selectedSymbol: symbol }),

  expandChart: (symbol) => {
    // Warm the history cache the moment the chart opens (grid click or search
    // pick) so the first paint — and the fit-to-history zoom — is instant
    // instead of waiting for a network round-trip after mount. The chart's own
    // loader reuses the same in-flight request (deduped by symbol/tf).
    if (symbol) {
      const s = get()
      const coin = s.coinMap.get(symbol)
      getOrFetchHistory(symbol, s.activeTimeframe, EXPANDED_CANDLE_LIMIT, coin?.exchange)
    }
    set({ expandedSymbol: symbol, selectedSymbol: symbol })
  },

  setTimeframe: (tf) => set({ activeTimeframe: tf }),

  setChartExchange: (ce) => {
    const s = get()
    if (s.chartExchange === ce) return
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(CHART_EXCHANGE_STORAGE_KEY, ce) } catch { /* ignore */ }
    }
    set({ chartExchange: ce, ...recompute({ ...s, chartExchange: ce, pageIndex: 0 }) })
  },

  setMinVolume24h: (v) => {
    const s = get()
    const clamped = Math.max(VOLUME_FILTER_MIN, Math.min(VOLUME_FILTER_MAX, v))
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(VOLUME_FILTER_STORAGE_KEY, String(clamped)) } catch { /* ignore */ }
    }
    set({ minVolume24h: clamped, ...recompute({ ...s, minVolume24h: clamped, pageIndex: 0 }) })
  },

  setPageIndex: (n) => {
    const s = get()
    set(recompute({ ...s, pageIndex: n }))
  },

  toggleWatch: (symbol) => set((s) => {
    const next = s.watchlist.includes(symbol)
      ? s.watchlist.filter(x => x !== symbol)
      : [...s.watchlist, symbol]
    persistWatchlist(next)
    // Re-sort immediately so the pin takes effect without waiting for the
    // next 5s snapshot.
    return { watchlist: next, ...recompute({ ...s, watchlist: next }) }
  }),

  init: () => {
    const unsubTicker = wsOnType('ticker', (msg) => {
      if (!Array.isArray(msg.data)) return
      const s = get()
      const coins = msg.data as UnifiedTicker[]
      // Server stamps delta:true on compact frames (changed entries only) and
      // snapshot:true on periodic full arrays. The initial push on connect is
      // an unmarked full array → treated as a snapshot.
      const isDelta = !!(msg as { delta?: boolean }).delta

      for (const c of coins) {
        setLivePrice(c.symbol, c.price)
      }

      const patch = applyTickerFrame(s, coins, isDelta)
      if (Object.keys(patch).length > 0) set(patch)
    })

    // Trade messages update only the live-price pub/sub — no array clones,
    // no React re-renders for components that don't read the price.
    const unsubTradeWild = wsOnMessage((msg) => {
      const t = msg.type as string | undefined
      if (!t || !t.startsWith('trade:')) return
      const trade = msg.data as any
      if (!trade || !trade.symbol) return
      const p = typeof trade.price === 'number' ? trade.price : parseFloat(trade.price)
      if (!isFinite(p) || p <= 0) return
      setLivePrice(trade.symbol as string, p)
    })

    wsSubscribe('ticker')

    // REST bootstrap: fill the list the moment the HTTP response lands instead
    // of waiting for the WS snapshot (one extra round-trip to the VPS). Only
    // applies while no WS ticker data has arrived — the WS snapshot (same
    // payload, fresher by definition) wins if it lands first, and the guard
    // prevents this older array from clobbering it.
    api.get('/coins')
      .then((res) => {
        const s = get()
        if (s.coins.length > 0) return
        const coins = res.data
        if (!Array.isArray(coins) || coins.length === 0) return
        set({ coins, ...recompute({ ...s, coins }) })
      })
      .catch(() => { /* WS snapshot covers */ })

    return () => {
      unsubTicker()
      unsubTradeWild()
    }
  },
}))

interface ChartStore {
  blocks: ChartBlock[]
  focusedBlockId: string | null
  addBlock: (symbol: string, tf?: Timeframe) => void
  removeBlock: (id: string) => void
  focusBlock: (id: string) => void
  setTimeframe: (id: string, tf: Timeframe) => void
  updateSymbol: (id: string, symbol: string) => void
}

let blockCounter = 0

export const useChartStore = create<ChartStore>((set) => ({
  blocks: [],
  focusedBlockId: null,

  addBlock: (symbol, tf = '1m') => {
    const id = `block-${++blockCounter}`
    const exchange = useCoinListStore.getState().coinMap.get(symbol)?.exchange
    set((s) => ({
      blocks: [...s.blocks, { id, symbol, timeframe: tf, focused: true, selected: false }],
      focusedBlockId: id,
    }))
    if (exchange) wsSubscribe(`candle:${exchange}:${symbol}:${tf}`)
  },

  removeBlock: (id) => set((s) => {
    const block = s.blocks.find(b => b.id === id)
    if (block) {
      const exchange = useCoinListStore.getState().coinMap.get(block.symbol)?.exchange
      if (exchange) wsUnsubscribe(`candle:${exchange}:${block.symbol}:${block.timeframe}`)
    }
    const blocks = s.blocks.filter(b => b.id !== id)
    return { blocks, focusedBlockId: blocks.length > 0 ? blocks[blocks.length - 1].id : null }
  }),

  focusBlock: (id) => set((s) => ({
    blocks: s.blocks.map(b => ({ ...b, focused: b.id === id, selected: b.id === id })),
    focusedBlockId: id,
  })),

  setTimeframe: (id, tf) => set((s) => {
    return {
      blocks: s.blocks.map(b => {
        if (b.id !== id) return b
        const exchange = useCoinListStore.getState().coinMap.get(b.symbol)?.exchange
        if (exchange) {
          wsUnsubscribe(`candle:${exchange}:${b.symbol}:${b.timeframe}`)
          wsSubscribe(`candle:${exchange}:${b.symbol}:${tf}`)
        }
        return { ...b, timeframe: tf }
      }),
    }
  }),

  updateSymbol: (id, symbol) => set((s) => {
    return {
      blocks: s.blocks.map(b => {
        if (b.id !== id) return b
        const cm = useCoinListStore.getState().coinMap
        const oldExchange = cm.get(b.symbol)?.exchange
        const newExchange = cm.get(symbol)?.exchange
        if (oldExchange) wsUnsubscribe(`candle:${oldExchange}:${b.symbol}:${b.timeframe}`)
        if (newExchange) wsSubscribe(`candle:${newExchange}:${symbol}:${b.timeframe}`)
        return { ...b, symbol }
      }),
    }
  }),
}))

interface AlertStore {
  alerts: AlertType[]
  init: () => () => void
  /** Show an alert the user just created (from the form or the chart bell tool). */
  addCreated: (alert: AlertType) => void
  dismissAlert: (id: string) => void
  muteAlert: (id: string) => void
}

export const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],

  init: () => {
    const unsub = wsOnType('alert', (msg) => {
      const alert = msg.data as AlertType
      set((s) => {
        // The same alert id is usually already in the list as a CREATED entry
        // (added right when the user made it) — upgrade it to the fired event
        // (price + triggeredAt) instead of showing a duplicate card.
        const existing = s.alerts.find(a => a.id === alert.id)
        if (existing) {
          return { alerts: s.alerts.map(a => a.id === alert.id ? { ...a, ...alert, active: false } : a) }
        }
        const next = [alert, ...s.alerts]
        // Cap at 100 to prevent unbounded growth
        return { alerts: next.slice(0, 100) }
      })
      // Sound + native browser notification for every fired alert.
      const settings = useAuthStore.getState().settings
      notifyNewAlert(alert, {
        sound: settings?.notifySound !== false,
        volume: settings?.notifyVolume ?? 1,
      })
    })
    return unsub
  },

  addCreated: (alert) => set((s) => {
    if (s.alerts.some(a => a.id === alert.id)) return s
    return { alerts: [alert, ...s.alerts].slice(0, 100) }
  }),

  dismissAlert: (id) => {
    set((s) => ({
      alerts: s.alerts.filter(a => a.id !== id),
    }))
    // Stop the alert server-side (delete the row) and remove its ray from any
    // chart that shows it — the list and the drawings stay in sync.
    emitAlertRemoved(id)
    api.delete(`/alerts/${id}`).catch(() => { /* already gone */ })
  },

  muteAlert: (id) => set((s) => ({
    alerts: s.alerts.map(a => a.id === id ? { ...a, muted: true } : a),
  })),
}))

interface AuthStore {
  userId: string | null
  username: string | null
  telegramVerified: boolean
  isLoggedIn: boolean
  isChecking: boolean
  settings: UserSettings | null
  checkSession: () => Promise<void>
  setUser: (user: { id: string; username: string; telegramVerified: boolean; settings?: UserSettings }) => void
  updateSettings: (settings: UserSettings) => Promise<void>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  userId: null,
  username: null,
  telegramVerified: false,
  isLoggedIn: false,
  isChecking: true,
  settings: null,

  checkSession: async () => {
    try {
      const res = await api.get('/auth/me')
      const user = res.data
      set({
        userId: user.id,
        username: user.username,
        telegramVerified: user.telegramVerified,
        isLoggedIn: true,
        isChecking: false,
        settings: user.settings ?? null,
      })
    } catch {
      set({ userId: null, username: null, telegramVerified: false, isLoggedIn: false, isChecking: false, settings: null })
    }
  },

  setUser: (user) => set({
    userId: user.id,
    username: user.username,
    telegramVerified: user.telegramVerified,
    isLoggedIn: true,
    settings: user.settings ?? null,
  }),

  updateSettings: async (settings) => {
    const { isLoggedIn, settings: current } = get()
    if (!isLoggedIn) return
    const merged = { ...current, ...settings } as UserSettings
    await api.put('/auth/settings', { settings: merged })
    set({ settings: merged })
  },

  logout: async () => {
    try { await api.post('/auth/logout') } catch { /* ignore */ }
    set({ userId: null, username: null, telegramVerified: false, isLoggedIn: false, settings: null })
  },
}))

interface UIStore {
  showAuth: boolean
  showProfile: boolean
  showExchangeModal: boolean
  showTickerSearch: boolean
  tickerSearchQuery: string
  setShowAuth: (v: boolean) => void
  setShowProfile: (v: boolean) => void
  setShowExchangeModal: (v: boolean) => void
  setShowTickerSearch: (v: boolean, query?: string) => void
}

export const useUIStore = create<UIStore>((set) => ({
  showAuth: false,
  showProfile: false,
  showExchangeModal: false,
  showTickerSearch: false,
  tickerSearchQuery: '',
  setShowAuth: (v) => set({ showAuth: v }),
  setShowProfile: (v) => set({ showProfile: v }),
  setShowExchangeModal: (v) => set({ showExchangeModal: v }),
  setShowTickerSearch: (v, query = '') => set({ showTickerSearch: v, tickerSearchQuery: query }),
}))
