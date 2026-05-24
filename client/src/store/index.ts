import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import type { UnifiedTicker, Timeframe, ChartBlock, Exchange, FilterExchange } from '../types.js'
import { wsOnMessage, wsOnType, wsSubscribe, wsUnsubscribe } from '../services/ws.js'

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

function sameTop9(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every(x => s.has(x))
}

function buildCoinMap(coins: UnifiedTicker[]): Map<string, UnifiedTicker> {
  const m = new Map<string, UnifiedTicker>()
  for (const c of coins) m.set(c.symbol, c)
  return m
}

interface CoinListStore {
  coins: UnifiedTicker[]
  sortedCoins: UnifiedTicker[]
  coinMap: Map<string, UnifiedTicker>
  topChartSymbols: string[]
  sortBy: keyof UnifiedTicker
  sortDir: 'asc' | 'desc'
  selectedSymbol: string | null
  expandedSymbol: string | null
  activeTimeframe: Timeframe
  filterExchange: FilterExchange
  setSort: (col: keyof UnifiedTicker) => void
  selectCoin: (symbol: string) => void
  expandChart: (symbol: string | null) => void
  setTimeframe: (tf: Timeframe) => void
  setFilterExchange: (fe: FilterExchange) => void
  init: () => () => void
}

let prevTopSymbols: string[] = []

function filterByExchange(coins: UnifiedTicker[], fe: FilterExchange): UnifiedTicker[] {
  if (fe === 'all') return coins
  return coins.filter(c => c.exchange.includes(fe))
}

function recompute(state: { coins: UnifiedTicker[]; sortBy: keyof UnifiedTicker; sortDir: 'asc' | 'desc'; filterExchange: FilterExchange }) {
  const filtered = filterByExchange(state.coins, state.filterExchange)
  const sorted = sortCoins(filtered, state.sortBy, state.sortDir)
  const newTop = sorted.slice(0, 9).map(c => c.symbol)
  const topChartSymbols = sameTop9(newTop, prevTopSymbols) ? prevTopSymbols : (prevTopSymbols = newTop)
  return { sortedCoins: sorted, coinMap: buildCoinMap(sorted), topChartSymbols }
}

// --- Live price store (decoupled from the heavy CoinListStore) ----------------
// Trade WS messages update per-symbol prices via a tiny pub/sub. Components
// that need live price use `useLivePrice(symbol)` and only re-render when
// THEIR symbol's price changes — no array clones, no global cascade.

const livePrices = new Map<string, number>()
const livePriceListeners = new Map<string, Set<() => void>>()
let globalLivePriceTick = 0

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

function setLivePrice(symbol: string, price: number) {
  const prev = livePrices.get(symbol)
  if (prev === price) return
  livePrices.set(symbol, price)
  globalLivePriceTick++
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
  topChartSymbols: [],
  sortBy: 'quoteVolume24h',
  sortDir: 'desc',
  selectedSymbol: null,
  expandedSymbol: null,
  activeTimeframe: '5m',
  filterExchange: 'all',

  setSort: (col) => {
    const s = get()
    const newDir: 'asc' | 'desc' = s.sortBy === col && s.sortDir === 'desc' ? 'asc' : 'desc'
    const next = { sortBy: col, sortDir: newDir }
    set({ ...next, ...recompute({ ...s, ...next }) })
  },

  selectCoin: (symbol) => set({ selectedSymbol: symbol }),

  expandChart: (symbol) => set({ expandedSymbol: symbol, selectedSymbol: symbol }),

  setTimeframe: (tf) => set({ activeTimeframe: tf }),

  setFilterExchange: (fe) => {
    const s = get()
    set({ filterExchange: fe, ...recompute({ ...s, filterExchange: fe }) })
  },

  init: () => {
    let lastSortUpdate = 0
    const SORT_INTERVAL = 3000

    const unsubTicker = wsOnType('ticker', (msg) => {
      if (!Array.isArray(msg.data)) return
      const s = get()
      const coins = msg.data as UnifiedTicker[]
      const now = Date.now()
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
        set({ coins: newCoins, sortedCoins: newSorted, coinMap: buildCoinMap(newSorted) })
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
    set((s) => ({
      blocks: [...s.blocks, { id, symbol, timeframe: tf, focused: true, selected: false }],
      focusedBlockId: id,
    }))
    wsSubscribe(`candle:${symbol}:${tf}`)
  },

  removeBlock: (id) => set((s) => {
    const block = s.blocks.find(b => b.id === id)
    if (block) wsUnsubscribe(`candle:${block.symbol}:${block.timeframe}`)
    const blocks = s.blocks.filter(b => b.id !== id)
    return { blocks, focusedBlockId: blocks.length > 0 ? blocks[blocks.length - 1].id : null }
  }),

  focusBlock: (id) => set((s) => ({
    blocks: s.blocks.map(b => ({ ...b, focused: b.id === id, selected: b.id === id })),
    focusedBlockId: id,
  })),

  setTimeframe: (id, tf) => set((s) => ({
    blocks: s.blocks.map(b => {
      if (b.id !== id) return b
      wsUnsubscribe(`candle:${b.symbol}:${b.timeframe}`)
      wsSubscribe(`candle:${b.symbol}:${tf}`)
      return { ...b, timeframe: tf }
    }),
  })),

  updateSymbol: (id, symbol) => set((s) => ({
    blocks: s.blocks.map(b => {
      if (b.id !== id) return b
      wsUnsubscribe(`candle:${b.symbol}:${b.timeframe}`)
      wsSubscribe(`candle:${symbol}:${b.timeframe}`)
      return { ...b, symbol }
    }),
  })),
}))

interface AlertStore {
  alerts: any[]
  init: () => () => void
  dismissAlert: (id: string) => void
  muteAlert: (id: string) => void
}

export const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],

  init: () => {
    const unsub = wsOnType('alert', (msg) => {
      set((s) => ({ alerts: [msg.data, ...s.alerts] }))
    })
    return unsub
  },

  dismissAlert: (id) => set((s) => ({
    alerts: s.alerts.filter((a: any) => a.id !== id),
  })),

  muteAlert: (id) => set((s) => ({
    alerts: s.alerts.map((a: any) => a.id === id ? { ...a, muted: true } : a),
  })),
}))

interface AuthStore {
  token: string | null
  email: string | null
  isLoggedIn: boolean
  login: (token: string, email: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  token: localStorage.getItem('token'),
  email: localStorage.getItem('email'),
  isLoggedIn: !!localStorage.getItem('token'),

  login: (token, email) => {
    localStorage.setItem('token', token)
    localStorage.setItem('email', email)
    set({ token, email, isLoggedIn: true })
  },

  logout: () => {
    localStorage.removeItem('token')
    localStorage.removeItem('email')
    set({ token: null, email: null, isLoggedIn: false })
  },
}))

interface UIStore {
  showLogin: boolean
  showProfile: boolean
  setShowLogin: (v: boolean) => void
  setShowProfile: (v: boolean) => void
}

export const useUIStore = create<UIStore>((set) => ({
  showLogin: false,
  showProfile: false,
  setShowLogin: (v) => set({ showLogin: v }),
  setShowProfile: (v) => set({ showProfile: v }),
}))
