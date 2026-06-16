import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import App from './App'
import { useUIStore, useCoinListStore } from './store'

// Mock the store modules with fully self-contained state so we can assert on
// state changes instead of tracking mock calls.
vi.mock('./store', () => {
  const makeStore = (initial: Record<string, unknown>) => {
    let state = { ...initial }
    return {
      getState: () => state,
      setState: (updater: Record<string, unknown> | ((s: typeof state) => typeof state)) => {
        state = typeof updater === 'function' ? updater(state) : { ...state, ...updater }
      },
      subscribe: vi.fn(),
      destroy: vi.fn(),
    }
  }

  const buildHook = (store: ReturnType<typeof makeStore>) => {
    const hook = (selector: (s: ReturnType<typeof store.getState>) => unknown) => selector(store.getState() as any)
    hook.getState = store.getState
    hook.setState = store.setState
    return hook
  }

  const uiStore = makeStore({
    showTickerSearch: false,
    tickerSearchQuery: '',
    showAuth: false,
    showProfile: false,
    showExchangeModal: false,
    setShowTickerSearch: (v: boolean, query = '') => {
      uiStore.setState({ showTickerSearch: v, tickerSearchQuery: query })
    },
  })

  const coinListStore = makeStore({
    expandedSymbol: null,
    pageIndex: 0,
    pageCount: 5,
    activeTimeframe: '1m',
    setPageIndex: (idx: number) => coinListStore.setState({ pageIndex: idx }),
    setTimeframe: (tf: string) => coinListStore.setState({ activeTimeframe: tf }),
    init: () => vi.fn(),
  })

  const authStore = makeStore({
    isChecking: false,
    isLoggedIn: true,
    settings: {},
    checkSession: vi.fn(),
  })

  return {
    useUIStore: buildHook(uiStore),
    useCoinListStore: buildHook(coinListStore),
    useAuthStore: buildHook(authStore),
  }
})

vi.mock('./store/drawingHotkeys', () => {
  const store = {
    getState: () => ({
      initFromSettings: vi.fn(),
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
    destroy: vi.fn(),
  }
  const hook = (selector: (s: { initFromSettings: ReturnType<typeof vi.fn> }) => unknown) => selector(store.getState() as any)
  hook.getState = store.getState
  hook.setState = store.setState
  return { useDrawingHotkeysStore: hook }
})

vi.mock('./hooks/useDrawingHotkeys', () => ({
  useDrawingHotkeys: () => {},
}))

vi.mock('./services/ws', () => ({
  wsConnect: vi.fn(),
  wsDisconnect: vi.fn(),
  ensureHealthyConnection: vi.fn(),
}))

vi.mock('./components/charts/ChartGrid', () => ({ ChartGrid: () => <div data-testid="chart-grid" /> }))
vi.mock('./components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('./components/layout/TopBar', () => ({ TopBar: () => <div data-testid="top-bar" /> }))
vi.mock('./components/layout/RightPanel', () => ({ RightPanel: () => <div data-testid="right-panel" /> }))
vi.mock('./components/auth/AuthModal', () => ({ default: () => <div data-testid="auth-modal" /> }))
vi.mock('./components/auth/ProfileModal', () => ({ ProfileModalGate: () => null }))
vi.mock('./components/exchange/ExchangeModal', () => ({ ExchangeModalGate: () => null }))
vi.mock('./components/search/TickerSearchModal', () => ({ TickerSearchModalGate: () => null }))
vi.mock('./components/ui/Toast', () => ({ ToastContainer: () => null }))

function fireKeyDown(
  options: { code: string; key?: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean },
  target: EventTarget = document.body,
) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: options.code,
    key: options.key ?? options.code.replace('Key', ''),
    shiftKey: options.shiftKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
  })
  Object.defineProperty(event, 'isComposing', { value: options.isComposing ?? false })
  target.dispatchEvent(event)
  return event
}

function resetStores() {
  useUIStore.setState({ showTickerSearch: false, tickerSearchQuery: '', showAuth: false, showProfile: false, showExchangeModal: false })
  useCoinListStore.setState({ expandedSymbol: null, pageIndex: 0, pageCount: 5 })
}

describe('App keyboard handler', () => {
  it('opens ticker search when a single letter key is pressed', () => {
    resetStores()
    render(<App />)
    const event = fireKeyDown({ code: 'KeyB' })
    expect(event.defaultPrevented).toBe(true)
    expect(useUIStore.getState().showTickerSearch).toBe(true)
    expect(useUIStore.getState().tickerSearchQuery).toBe('B')
  })

  it('does not open ticker search when Shift+letter is pressed (reserved for drawing tools)', () => {
    resetStores()
    render(<App />)
    const event = fireKeyDown({ code: 'KeyD', shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(useUIStore.getState().showTickerSearch).toBe(false)
  })

  it('does not open ticker search when Ctrl+letter is pressed', () => {
    resetStores()
    render(<App />)
    const event = fireKeyDown({ code: 'KeyB', ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(useUIStore.getState().showTickerSearch).toBe(false)
  })

  it('does not open ticker search when Alt+letter is pressed', () => {
    resetStores()
    render(<App />)
    const event = fireKeyDown({ code: 'KeyB', altKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(useUIStore.getState().showTickerSearch).toBe(false)
  })

  it('does not open ticker search when Meta+letter is pressed', () => {
    resetStores()
    render(<App />)
    const event = fireKeyDown({ code: 'KeyB', metaKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(useUIStore.getState().showTickerSearch).toBe(false)
  })

  it('does not open search when a modal is already open', () => {
    resetStores()
    useUIStore.setState({ showAuth: true })
    render(<App />)
    const event = fireKeyDown({ code: 'KeyB' })
    expect(useUIStore.getState().showTickerSearch).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not open search when an interactive element is focused', () => {
    resetStores()
    render(<App />)
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    try {
      const event = fireKeyDown({ code: 'KeyB' }, button)
      expect(useUIStore.getState().showTickerSearch).toBe(false)
      expect(event.defaultPrevented).toBe(false)
    } finally {
      document.body.removeChild(button)
    }
  })

  it('changes timeframe on number keys', () => {
    resetStores()
    render(<App />)
    const event = fireKeyDown({ code: 'Digit1', key: '1' })
    expect(event.defaultPrevented).toBe(true)
    expect(useCoinListStore.getState().activeTimeframe).toBe('1m')
  })

  it('advances page on Space when not on last page and no chart expanded', () => {
    resetStores()
    render(<App />)
    const event = fireKeyDown({ code: 'Space', key: ' ' })
    expect(event.defaultPrevented).toBe(true)
    expect(useCoinListStore.getState().pageIndex).toBe(1)
  })
})
