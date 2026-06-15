import { useEffect } from 'react'
import { ChartGrid } from './components/charts/ChartGrid'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TopBar } from './components/layout/TopBar'
import { RightPanel } from './components/layout/RightPanel'
import AuthModal from './components/auth/AuthModal'
import { ProfileModalGate } from './components/auth/ProfileModal'
import { ExchangeModalGate } from './components/exchange/ExchangeModal'
import { TickerSearchModalGate } from './components/search/TickerSearchModal'
import { useCoinListStore, useAuthStore, useUIStore } from './store'
import { wsConnect, wsDisconnect, ensureHealthyConnection } from './services/ws'
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

function App() {
  const coinListInit = useCoinListStore(s => s.init)
  const checkSession = useAuthStore(s => s.checkSession)
  const isChecking = useAuthStore(s => s.isChecking)
  const isLoggedIn = useAuthStore(s => s.isLoggedIn)

  useEffect(() => {
    checkSession()
  }, [checkSession])

  useEffect(() => {
    if (isChecking || !isLoggedIn) return
    wsConnect()
    const unsub = coinListInit()

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
      unsub()
      wsDisconnect()
    }
  }, [coinListInit, isChecking, isLoggedIn])

  // Пробел — перейти к следующей странице мини-графиков (на последней останавливается).
  // Любая буква — открыть модалку поиска тикера и ввести её в поле.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const hotkeyTimeframe = TIMEFRAME_HOTKEYS[e.key]
      const isSpace = e.code === 'Space'
      const isLetter = e.key.length === 1 && /[A-Za-z]/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey
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
        e.preventDefault()
        useUIStore.setState({ showTickerSearch: true })
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
    return <AuthModal />
  }

  // Logged in — main app
  return (
    <div className="w-full h-full flex flex-col bg-[#0a0a0a]">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <ErrorBoundary fallback={<div className="flex-1 h-full flex items-center justify-center text-[#333]">Chart error</div>}>
          <ChartGrid />
        </ErrorBoundary>
        <div className="w-[1px] bg-[#1f1f1f] flex-shrink-0" />
        <RightPanel />
      </div>
      <ProfileModalGate />
      <ExchangeModalGate />
      <TickerSearchModalGate />
    </div>
  )
}

export default App
