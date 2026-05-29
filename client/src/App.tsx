import { useEffect } from 'react'
import { ChartGrid } from './components/charts/ChartGrid'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TopBar } from './components/layout/TopBar'
import { RightPanel } from './components/layout/RightPanel'
import { LoginModal } from './components/auth/LoginModal'
import { ProfileModal } from './components/auth/ProfileModal'
import { useCoinListStore, useUIStore } from './store'
import { wsConnect, wsDisconnect } from './services/ws'

function App() {
  const coinListInit = useCoinListStore(s => s.init)
  const { showLogin, showProfile } = useUIStore()

  useEffect(() => {
    wsConnect()
    const unsub = coinListInit()
    return () => {
      unsub()
      wsDisconnect()
    }
  }, [coinListInit])

  // Пробел — перейти к следующей странице мини-графиков (на последней останавливается).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar'
      if (!isSpace || e.isComposing) return

      // Не перехватываем Пробел, когда в фокусе поле ввода или интерактивный элемент —
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
      if (ui.showLogin || ui.showProfile) return
      const s = useCoinListStore.getState()
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
      {showLogin && <LoginModal />}
      {showProfile && <ProfileModal />}
    </div>
  )
}

export default App
