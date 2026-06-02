import { useEffect } from 'react'
import { ChartGrid } from './components/charts/ChartGrid'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TopBar } from './components/layout/TopBar'
import { RightPanel } from './components/layout/RightPanel'
import AuthModal from './components/auth/AuthModal'
import ProfileModal from './components/auth/ProfileModal'
import { useCoinListStore, useAuthStore, useUIStore } from './store'
import { wsConnect, wsDisconnect } from './services/ws'
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
  const { showAuth, showProfile } = useUIStore()

  useEffect(() => {
    checkSession()
  }, [checkSession])

  useEffect(() => {
    if (isChecking || !isLoggedIn) return
    wsConnect()
    const unsub = coinListInit()
    return () => {
      unsub()
      wsDisconnect()
    }
  }, [coinListInit, isChecking, isLoggedIn])

  // Пробел — перейти к следующей странице мини-графиков (на последней останавливается).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const hotkeyTimeframe = TIMEFRAME_HOTKEYS[e.key]
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar'
      if ((!hotkeyTimeframe && !isSpace) || e.isComposing) return

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

      // Не листаем при открытом модальном окне или в развёрнутом графике.
      const ui = useUIStore.getState()
      if (ui.showAuth || ui.showProfile) return
      const s = useCoinListStore.getState()

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
      {showProfile && <ProfileModal />}
    </div>
  )
}

export default App
