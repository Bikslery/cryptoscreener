import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import type { UnifiedTicker, Timeframe, ChartBlock, Exchange, Alert as AlertType } from '../types.js'
import { wsOnMessage, wsOnType, wsSubscribe, wsUnsubscribe } from '../services/ws.js'
import api from '../services/api.js'
import { VOLUME_HIGH_THRESHOLD, VOLUME_FILTER_DEFAULT } from '../constants/volume.js'

export type ChartExchange = 'binance-spot' | 'binance-futures'

const CHART_EXCHANGE_STORAGE_KEY = 'serotonin.chartExchange'
const VALID_CHART_EXCHANGES: ChartExchange[] = ['binance-spot', 'binance-futures']
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

function sortCoins(coins: UnifiedTicker[], sortBy: keyof UnifiedTicker, sortDir: 'asc' | 'desc'): UnifiedTicker[] {
  return dedup(coins).sort((a, b) => {
    const dir = sortDir === 'desc' ? -1 : 1
    const aVal = a[sortBy] ?? 0
    const bVal = b[sortBy] ?? 0
    if (typeof aVal === 'string' && typeof bVal === 'string') return dir * aVal.localeCompare(bVal)
    return dir * ((aVal as number) - (bVal as number))
  })
}


function buildCoinMap(coins: UnifiedTicker[]): Map<string, UnifiedTicker> {
  const m = new Map<string, UnifiedTicker>()
  for (const c of coins) m.set(c.symbol, c)
  return m
}

const VOLUME_FILTER_MIN = 0
const VOLUME_FILTER_MAX = VOLUME_HIGH_THRESHOLD
const VOLUME_FILTER_STORAGE_KEY = 'serotonin.minVolume24h'

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

function recompute(state: { coins: UnifiedTicker[]; sortBy: keyof UnifiedTicker; sortDir: 'asc' | 'desc'; chartExchange: ChartExchange; minVolume24h: number; pageIndex: number }) {
  const byExchange = filterByChartExchange(state.coins, state.chartExchange)
  const filtered = filterByMinVolume(byExchange, state.minVolume24h)
  const sorted = sortCoins(filtered, state.sortBy, state.sortDir)
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

function subscribeLivePrice(symbol: string, listener: () => void): () => void {
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

export function setLivePrice(symbol: string, price: number) {
  const prev = livePrices.get(symbol)
  if (prev === price) return
  livePrices.set(symbol, price)
  const set = livePriceListeners.get(symbol)
  if (set) for (const l of set) l()
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

  expandChart: (symbol) => set({ expandedSymbol: symbol, selectedSymbol: symbol }),

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

  init: () => {
    let lastSortUpdate = 0
    const SORT_INTERVAL = 10000

    const unsubTicker = wsOnType('ticker', (msg) => {
      if (!Array.isArray(msg.data)) return
      const s = get()
      const coins = msg.data as UnifiedTicker[]
      const now = Date.now()
      for (const c of coins) {
        setLivePrice(c.symbol, c.price)
      }
      if (!s.autoRefresh) {
        // Auto-refresh off: still update prices but skip re-sorting
        const updateMap = new Map<string, UnifiedTicker>()
        for (const c of coins) updateMap.set(c.symbol, c)

        let dirty = false
        const newCoins = s.coins.map((c) => {
          const u = updateMap.get(c.symbol)
          if (!u) return c
          if (u.price === c.price && u.change24h === c.change24h && u.quoteVolume24h === c.quoteVolume24h) return c
          dirty = true
          return u
        })
        if (!dirty) return

        const newSorted = s.sortedCoins.map((c) => updateMap.get(c.symbol) || c)
        const newCoinMap = new Map(s.coinMap)
        for (const [sym, u] of updateMap) newCoinMap.set(sym, u)
        set({ coins: newCoins, sortedCoins: newSorted, coinMap: newCoinMap })
        return
      }
      if (now - lastSortUpdate > SORT_INTERVAL) {
        lastSortUpdate = now
        set({ coins, ...recompute({ ...s, coins }) })
      } else {
        // Quick price refresh without re-sorting/re-cloning everything.
        // Merge in place: build a small updates map, then patch arrays
        // using identity-preserving updates only for changed coins.
        const updateMap = new Map<string, UnifiedTicker>()
        for (const c of coins) updateMap.set(c.symbol, c)

        let dirty = false
        const newCoins = s.coins.map((c) => {
          const u = updateMap.get(c.symbol)
          if (!u) return c
          if (u.price === c.price && u.change24h === c.change24h && u.quoteVolume24h === c.quoteVolume24h) return c
          dirty = true
          return u
        })
        if (!dirty) return

        const newSorted = s.sortedCoins.map((c) => updateMap.get(c.symbol) || c)
        const newCoinMap = new Map(s.coinMap)
        for (const [sym, u] of updateMap) newCoinMap.set(sym, u)
        set({ coins: newCoins, sortedCoins: newSorted, coinMap: newCoinMap })
      }
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
  dismissAlert: (id: string) => void
  muteAlert: (id: string) => void
}

export const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],

  init: () => {
    const unsub = wsOnType('alert', (msg) => {
      set((s) => {
        const next = [msg.data as AlertType, ...s.alerts]
        // Cap at 100 to prevent unbounded growth
        return { alerts: next.slice(0, 100) }
      })
    })
    return unsub
  },

  dismissAlert: (id) => set((s) => ({
    alerts: s.alerts.filter(a => a.id !== id),
  })),

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
  checkSession: () => Promise<void>
  setUser: (user: { id: string; username: string; telegramVerified: boolean }) => void
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthStore>((set) => ({
  userId: null,
  username: null,
  telegramVerified: false,
  isLoggedIn: false,
  isChecking: true,

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
      })
    } catch {
      set({ userId: null, username: null, telegramVerified: false, isLoggedIn: false, isChecking: false })
    }
  },

  setUser: (user) => set({
    userId: user.id,
    username: user.username,
    telegramVerified: user.telegramVerified,
    isLoggedIn: true,
  }),

  logout: async () => {
    try { await api.post('/auth/logout') } catch { /* ignore */ }
    set({ userId: null, username: null, telegramVerified: false, isLoggedIn: false })
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
  setShowTickerSearch: (v: boolean) => void
  setTickerSearchQuery: (v: string) => void
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
  setShowTickerSearch: (v) => set({ showTickerSearch: v }),
  setTickerSearchQuery: (v) => set({ tickerSearchQuery: v }),
}))
