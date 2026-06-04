import { useCoinListStore, useAuthStore, useUIStore } from '../../store'
import type { Timeframe, FilterExchange } from '../../types'
import { LogIn, User, ChevronFirst, ChevronLeft, ChevronRight } from 'lucide-react'

const TF_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1М' },
  { value: '5m', label: '5М' },
  { value: '15m', label: '15М' },
  { value: '1h', label: '1Ч' },
  { value: '4h', label: '4Ч' },
  { value: '1d', label: 'Д' },
  { value: '1w', label: 'Н' },
]

const EXCHANGE_FILTERS: { value: FilterExchange; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'okx', label: 'OKX' },
]

export function TopBar() {
  const activeTf = useCoinListStore(s => s.activeTimeframe)
  const setTimeframe = useCoinListStore(s => s.setTimeframe)
  const filterExchange = useCoinListStore(s => s.filterExchange)
  const setFilterExchange = useCoinListStore(s => s.setFilterExchange)
  const pageIndex = useCoinListStore(s => s.pageIndex)
  const pageCount = useCoinListStore(s => s.pageCount)
  const setPageIndex = useCoinListStore(s => s.setPageIndex)
  const isLoggedIn = useAuthStore(s => s.isLoggedIn)
  const { setShowAuth, setShowProfile } = useUIStore()

  return (
    <div
      className="flex items-center justify-between gap-3 pl-[15px] pr-4 h-[48px] bg-[#0e0e0e] border-b border-[#1f1f1f] flex-shrink-0 select-none overflow-x-auto"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* Лево: логотип */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-bold text-[13px] text-white tracking-tight">serotonin.clinic</span>
      </div>

      {/* Центр: таймфреймы + пагинация */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-[2px]">
          {TF_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`clinic-btn clinic-btn-sm text-[12px] leading-none ${
                activeTf === opt.value ? 'clinic-btn-active' : 'clinic-btn-secondary'
              }`}
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
          className="clinic-btn clinic-btn-sm flex items-center justify-center h-[30px] px-[9px] text-[12px]"
          onClick={() => setPageIndex(0)}
        >
          <ChevronFirst size={15} />
        </button>

        <button
          aria-label="Предыдущие 9 графиков"
          disabled={pageIndex === 0}
          className="clinic-btn clinic-btn-sm flex items-center justify-center h-[30px] px-[9px] text-[12px]"
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
          className="clinic-btn clinic-btn-sm flex items-center justify-center h-[30px] px-[9px] text-[12px]"
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
            className={`clinic-btn clinic-btn-sm text-[12px] ${
              filterExchange === f.value
                ? 'clinic-btn-exchange-active'
                : 'clinic-btn-ghost'
            }`}
            onClick={() => setFilterExchange(f.value)}
          >
            {f.label}
          </button>
        ))}

        <div className="w-[1px] h-[20px] bg-[#1f1f1f] mx-2" />

        {isLoggedIn ? (
          <button
            className="clinic-btn clinic-btn-ghost clinic-btn-sm flex items-center gap-1.5 text-[11px]"
            onClick={() => setShowProfile(true)}
          >
            <User size={13} />
            <span>Личный кабинет</span>
          </button>
        ) : (
          <button
            className="clinic-btn clinic-btn-ghost clinic-btn-sm flex items-center gap-1.5 text-[11px]"
            onClick={() => setShowAuth(true)}
          >
            <LogIn size={13} />
            Вход
          </button>
        )}
      </div>
    </div>
  )
}
