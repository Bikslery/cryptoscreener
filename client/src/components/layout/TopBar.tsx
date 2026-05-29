import { useCoinListStore, useAuthStore, useUIStore } from '../../store'
import type { Timeframe, FilterExchange } from '../../types'
import { LogIn, User, ChevronFirst, ChevronLeft, ChevronRight } from 'lucide-react'

const TF_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1М' },
  { value: '3m', label: '3М' },
  { value: '5m', label: '5М' },
  { value: '15m', label: '15М' },
  { value: '30m', label: '30М' },
  { value: '1h', label: '1Ч' },
  { value: '2h', label: '2Ч' },
  { value: '4h', label: '4Ч' },
  { value: '1d', label: '1Д' },
  { value: '1w', label: '1Н' },
]

const EXCHANGE_FILTERS: { value: FilterExchange; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'okx', label: 'OKX' },
]

function ScalpBoardLogo() {
  return (
    <svg viewBox="0 0 420 420" fill="none" className="w-5 h-5">
      <path d="M360 280C360 291.046 351.046 300 340 300L300 300L300 20C300 8.954 308.954 0 320 0L340 0C351.046 0 360 8.954 360 20L360 280Z" fill="currentColor" />
      <path d="M120 400C120 411.046 111.046 420 100 420L80 420C68.954 420 60 411.046 60 400L60 140C60 128.954 68.954 120 80 120L120 120L120 400Z" fill="currentColor" />
      <path d="M330 120L120 120L120 80C120 68.954 128.954 60 140 60L330 60L330 120Z" fill="currentColor" />
      <rect x="240" y="240" width="60" height="60" rx="20" transform="rotate(-180 240 240)" fill="currentColor" />
      <path d="M300 340C300 351.046 291.046 360 280 360L90 360L90 300L300 300L300 340Z" fill="currentColor" />
    </svg>
  )
}

export function TopBar() {
  const activeTf = useCoinListStore(s => s.activeTimeframe)
  const setTimeframe = useCoinListStore(s => s.setTimeframe)
  const filterExchange = useCoinListStore(s => s.filterExchange)
  const setFilterExchange = useCoinListStore(s => s.setFilterExchange)
  const pageIndex = useCoinListStore(s => s.pageIndex)
  const pageCount = useCoinListStore(s => s.pageCount)
  const setPageIndex = useCoinListStore(s => s.setPageIndex)
  const { isLoggedIn, email } = useAuthStore()
  const { setShowLogin, setShowProfile } = useUIStore()

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 h-[48px] bg-[#0e0e0e] border-b border-[#1f1f1f] flex-shrink-0 select-none overflow-x-auto"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* Лево: логотип */}
      <div className="flex items-center gap-2 shrink-0">
        <ScalpBoardLogo />
        <span className="font-bold text-[13px] text-white tracking-tight">ScalpBoard</span>
      </div>

      {/* Центр: таймфреймы + пагинация */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex h-[30px] border border-[#2a2a2a] rounded-[4px] overflow-hidden bg-[#1a1a1a]">
          {TF_OPTIONS.map((opt, i) => (
            <button
              key={opt.value}
              className={`
                flex items-center justify-center h-full px-[12px] text-[12px] font-mono font-medium transition-all duration-150 cursor-pointer
                ${i < TF_OPTIONS.length - 1 ? 'border-r border-[#2a2a2a]' : ''}
                ${activeTf === opt.value
                  ? 'bg-[#3a3a3a] text-[#fff]'
                  : 'text-[#888] hover:bg-[#242424] hover:text-[#bbb]'
                }
              `}
              onClick={() => setTimeframe(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="w-[1px] h-[20px] bg-[#1f1f1f] mx-2" />

        <button
          aria-label="На первую страницу"
          disabled={pageIndex === 0}
          className={`
            flex items-center justify-center h-[30px] px-[9px] text-[12px] font-mono font-medium rounded-[4px] border transition-all duration-150
            disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-[#1a1a1a] disabled:hover:text-[#888] disabled:hover:border-[#2a2a2a]
            bg-[#1a1a1a] text-[#888] border-[#2a2a2a] hover:bg-[#242424] hover:text-[#bbb] hover:border-[#3a3a3a] cursor-pointer
          `}
          onClick={() => setPageIndex(0)}
        >
          <ChevronFirst size={15} />
        </button>

        <button
          aria-label="Предыдущие 9 графиков"
          disabled={pageIndex === 0}
          className={`
            flex items-center justify-center h-[30px] px-[9px] text-[12px] font-mono font-medium rounded-[4px] border transition-all duration-150
            disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-[#1a1a1a] disabled:hover:text-[#888] disabled:hover:border-[#2a2a2a]
            bg-[#1a1a1a] text-[#888] border-[#2a2a2a] hover:bg-[#242424] hover:text-[#bbb] hover:border-[#3a3a3a] cursor-pointer
          `}
          onClick={() => setPageIndex(pageIndex - 1)}
        >
          <ChevronLeft size={15} />
        </button>

        <span className="px-[10px] text-[12px] font-mono text-[#aaa] tabular-nums">
          {pageIndex + 1} / {pageCount}
        </span>

        <button
          aria-label="Следующие 9 графиков"
          disabled={pageIndex >= pageCount - 1}
          className={`
            flex items-center justify-center h-[30px] px-[9px] text-[12px] font-mono font-medium rounded-[4px] border transition-all duration-150
            disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-[#1a1a1a] disabled:hover:text-[#888] disabled:hover:border-[#2a2a2a]
            bg-[#1a1a1a] text-[#888] border-[#2a2a2a] hover:bg-[#242424] hover:text-[#bbb] hover:border-[#3a3a3a] cursor-pointer
          `}
          onClick={() => setPageIndex(pageIndex + 1)}
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Право: фильтры бирж + авторизация */}
      <div className="flex items-center gap-[2px] shrink-0">
        {EXCHANGE_FILTERS.map(f => (
          <button
            key={f.value}
            className={`
              flex items-center justify-center h-[30px] px-[10px] text-[12px] font-medium rounded-[4px] border transition-all duration-150 cursor-pointer
              ${filterExchange === f.value
                ? 'bg-white text-black border-white'
                : 'bg-transparent text-[#666] border-transparent hover:text-[#aaa] hover:border-[#2a2a2a]'
              }
            `}
            onClick={() => setFilterExchange(f.value)}
          >
            {f.label}
          </button>
        ))}

        <div className="w-[1px] h-[20px] bg-[#1f1f1f] mx-2" />

        {isLoggedIn ? (
          <button
            className="flex items-center gap-1.5 h-[30px] px-2 text-[11px] text-[#aaa] hover:text-white transition-colors cursor-pointer"
            onClick={() => setShowProfile(true)}
          >
            <User size={13} />
            <span className="max-w-[100px] truncate">{email}</span>
          </button>
        ) : (
          <button
            className="flex items-center gap-1.5 h-[30px] px-2 text-[11px] text-[#aaa] hover:text-white transition-colors cursor-pointer"
            onClick={() => setShowLogin(true)}
          >
            <LogIn size={13} />
            Вход
          </button>
        )}
      </div>
    </div>
  )
}
