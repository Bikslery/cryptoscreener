import { useEffect, lazy, Suspense, useState, useCallback } from 'react'
import { ChartGrid } from './components/charts/ChartGrid'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TopBar } from './components/layout/TopBar'
import { RightPanel } from './components/layout/RightPanel'
// Modal-heavy screens are code-split so the main bundle (loaded by every
// logged-in user on first paint) only contains the chart grid, list and WS
// plumbing. Each modal downloads its own chunk on first open.
const AuthModal = lazy(() => import('./components/auth/AuthModal'))
const TelegramGate = lazy(() => import('./components/auth/TelegramGate'))
const ProfileModalGate = lazy(() => import('./components/auth/ProfileModal').then(m => ({ default: m.ProfileModalGate })))
const ExchangeModalGate = lazy(() => import('./components/exchange/ExchangeModal').then(m => ({ default: m.ExchangeModalGate })))
const TickerSearchModalGate = lazy(() => import('./components/search/TickerSearchModal').then(m => ({ default: m.TickerSearchModalGate })))
import { useCoinListStore, useAuthStore, useUIStore, useAlertStore } from './store'
import { useDrawingHotkeysStore } from './store/drawingHotkeys'
import { wsConnect, wsDisconnect, ensureHealthyConnection } from './services/ws'
import { initAlertNotifications } from './services/alert-notify'
import { getEnglishLetterFromKeyCode } from './utils/keyboard'
import { useDrawingHotkeys } from './hooks/useDrawingHotkeys'
import { ToastContainer } from './components/ui/Toast'
import type { Timeframe } from './types'

const TIMEFRAME_HOTKEYS: Record<string, Timeframe> = {
  '1': '1m',
  '2': '5m',
  '3': '15m',
  '4': '1h',
  '5': '4h',
  '6': '1d',
  '7': '1w',
}

// Right ticker panel: resizable width only (height is fixed to the layout).
const PANEL_WIDTH_KEY = 'crypto-screener:right-panel-width'
const PANEL_WIDTH_DEFAULT = 480
const PANEL_WIDTH_MIN = 320
const PANEL_WIDTH_MAX = 900

function clampPanelWidth(v: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, v))
}

function readPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : PANEL_WIDTH_DEFAULT
}

function App() {
  const coinListInit = useCoinListStore(s => s.init)
  const alertInit = useAlertStore(s => s.init)
  const [panelWidth, setPanelWidth] = useState(readPanelWidth)

  const startPanelDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidth
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const onMove = (ev: PointerEvent) => {
      setPanelWidth(clampPanelWidth(startW + (startX - ev.clientX)))
    }
    const onUp = (ev: PointerEvent) => {
      const next = clampPanelWidth(startW + (startX - ev.clientX))
      setPanelWidth(next)
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(next)) } catch { /* private mode */ }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [panelWidth])

  const resetPanelWidth = useCallback(() => {
    setPanelWidth(PANEL_WIDTH_DEFAULT)
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(PANEL_WIDTH_DEFAULT)) } catch { /* private mode */ }
  }, [])

  const checkSession = useAuthStore(s => s.checkSession)
  const isChecking = useAuthStore(s => s.isChecking)
  const isLoggedIn = useAuthStore(s => s.isLoggedIn)
  const telegramVerified = useAuthStore(s => s.telegramVerified)
  const settings = useAuthStore(s => s.settings)
  const initHotkeys = useDrawingHotkeysStore(s => s.initFromSettings)

  useDrawingHotkeys()

  useEffect(() => {
    checkSession()
  }, [checkSession])

  useEffect(() => {
    if (isChecking) return
    initHotkeys(settings ?? undefined)
  }, [isChecking, settings, initHotkeys])

  useEffect(() => {
    if (isChecking || !isLoggedIn) return
    wsConnect()
    initAlertNotifications()
    const unsub = coinListInit()
    // Fired alerts must reach the page (cards + sound + native notifications) —
    // without this WS listener they only ever arrive in Telegram.
    const unsubAlerts = alertInit()

    // Browsers throttle/suspend background tabs, which can silently kill the
    // WebSocket. Re-validate the connection the instant the user comes back or
    // the network returns, so charts never sit dead after a minimized tab.
    let lastCheck = 0
    const revive = () => {
      const now = Date.now()
      if (now - lastCheck < 1000) return // debounce focus/visibility storms
      lastCheck = now
      ensureHealthyConnection()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') revive()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', revive)
    window.addEventListener('online', revive)
    window.addEventListener('pageshow', revive) // bfcache restore

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', revive)
      window.removeEventListener('online', revive)
      window.removeEventListener('pageshow', revive)
      unsubAlerts()
      unsub()
      wsDisconnect()
    }
  }, [coinListInit, alertInit, isChecking, isLoggedIn])

  // Пробел — перейти к следующей странице мини-графиков (на последней останавливается).
  // Любая буква — открыть модалку поиска тикера и ввести её в поле.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const hotkeyTimeframe = TIMEFRAME_HOTKEYS[e.key]
      const isSpace = e.code === 'Space'
      const letter = getEnglishLetterFromKeyCode(e.code)
      // Shift+<letter> зарезервировано под горячие клавиши рисования (shift+d/s/a),
      // поэтому при зажатом Shift не открываем поиск тикера.
      const isLetter = letter !== null && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
      if ((!hotkeyTimeframe && !isSpace && !isLetter) || e.isComposing) return

      // Не перехватываем горячие клавиши, когда в фокусе поле ввода или интерактивный элемент —
      // пусть отрабатывает их штатное поведение (ввод текста, активация кнопки/ссылки).
      // Это заодно убирает двойное перелистывание в Firefox, где preventDefault на
      // keydown не отменяет клик сфокусированной кнопки.
      const el = (e.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null)
      if (el) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || el.isContentEditable) return
        const role = el.getAttribute('role')
        if (role === 'button' || role === 'link' || role === 'tab' || role === 'checkbox' || role === 'menuitem' || role === 'switch') return
      }

      // Не листаем и не открываем поиск при открытом модальном окне или в развёрнутом графике.
      const ui = useUIStore.getState()
      if (ui.showAuth || ui.showProfile || ui.showExchangeModal || ui.showTickerSearch) return
      const s = useCoinListStore.getState()

      if (isLetter) {
        if (e.defaultPrevented) return
        e.preventDefault()
        useUIStore.getState().setShowTickerSearch(true, letter)
        return
      }

      if (hotkeyTimeframe) {
        e.preventDefault()
        if (e.repeat) return
        s.setTimeframe(hotkeyTimeframe)
        return
      }

      if (s.expandedSymbol) return

      // Фокус не на интерактивном элементе — Пробел листает сетку: гасим прокрутку страницы.
      e.preventDefault()
      if (e.repeat) return // одна страница на одно нажатие, без авто-повтора при удержании
      if (s.pageIndex >= s.pageCount - 1) return // на последней странице — стоп
      s.setPageIndex(s.pageIndex + 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Loading session check
  if (isChecking) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0a0a0a]">
        <div className="text-zinc-500 text-lg">Загрузка...</div>
      </div>
    )
  }

  // Not logged in — auth gate (full screen, no charts behind)
  if (!isLoggedIn) {
    return (
      <Suspense fallback={
        <div className="w-full h-full flex items-center justify-center bg-[#0a0a0a]">
          <div className="text-zinc-500 text-lg">Загрузка...</div>
        </div>
      }>
        <AuthModal />
      </Suspense>
    )
  }

  // Logged in but Telegram not bound — hard gate (survives page reloads:
  // the bind step lives in this component, not in modal state).
  if (!telegramVerified) {
    return (
      <Suspense fallback={
        <div className="w-full h-full flex items-center justify-center bg-[#0a0a0a]">
          <div className="text-zinc-500 text-lg">Загрузка...</div>
        </div>
      }>
        <TelegramGate />
      </Suspense>
    )
  }

  // Logged in — main app
  return (
    <div className="w-full h-full flex flex-col bg-[#0a0a0a]">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <ErrorBoundary fallback={<div className="flex-1 h-full flex items-center justify-center text-[#333]">Chart error</div>}>
          <ChartGrid />
        </ErrorBoundary>
        <div
          className="group w-[5px] h-full flex-shrink-0 cursor-col-resize flex items-stretch justify-center touch-none select-none"
          title="Перетащите, чтобы изменить ширину панели. Двойной клик — сброс."
          onPointerDown={startPanelDrag}
          onDoubleClick={resetPanelWidth}
        >
          <div className="w-[1px] h-full bg-[#1f1f1f] group-hover:bg-[#6f4db3] transition-colors" />
        </div>
        <RightPanel width={panelWidth} />
      </div>
      <Suspense fallback={null}>
        <ProfileModalGate />
        <ExchangeModalGate />
        <TickerSearchModalGate />
      </Suspense>
      <ToastContainer />
    </div>
  )
}

export default App
