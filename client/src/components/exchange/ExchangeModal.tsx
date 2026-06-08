import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useCoinListStore, useUIStore } from '../../store'
import type { ChartExchange } from '../../store'
import { X, ArrowLeftRight, Check } from 'lucide-react'
import './ExchangeModal.css'

interface ExchangeOption {
  value: ChartExchange
  label: string
  hint: string
}

const EXCHANGE_OPTIONS: ExchangeOption[] = [
  { value: 'binance-futures', label: 'Binance Futures', hint: 'фьючерсы USDT-M' },
  { value: 'binance-spot', label: 'Binance Spot', hint: 'спотовый рынок' },
]

export default function ExchangeModal() {
  const { setShowExchangeModal } = useUIStore()
  const chartExchange = useCoinListStore(s => s.chartExchange)
  const setChartExchange = useCoinListStore(s => s.setChartExchange)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setShowExchangeModal(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setShowExchangeModal])

  const handleSelect = (value: ChartExchange) => {
    if (value === chartExchange) {
      setShowExchangeModal(false)
      return
    }
    setChartExchange(value)
    setShowExchangeModal(false)
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="exchange-overlay" onClick={() => setShowExchangeModal(false)}>
      <div className="exchange-backdrop" />
      <div className="exchange-modal" onClick={(e) => e.stopPropagation()}>
        <div className="exchange-header">
          <div className="exchange-header-icon">
            <ArrowLeftRight size={14} />
          </div>
          <div className="exchange-header-info">
            <div className="exchange-title">Сменить биржу</div>
            <div className="exchange-subtitle">источник данных для графиков</div>
          </div>
          <button
            className="exchange-close"
            onClick={() => setShowExchangeModal(false)}
            aria-label="Закрыть"
          >
            <X size={14} />
          </button>
        </div>

        <div className="exchange-options">
          {EXCHANGE_OPTIONS.map((opt) => {
            const isActive = opt.value === chartExchange
            return (
              <button
                key={opt.value}
                className={`exchange-option ${isActive ? 'active' : ''}`}
                onClick={() => handleSelect(opt.value)}
              >
                <div className="exchange-option-main">
                  <span className="exchange-option-label">{opt.label}</span>
                  <span className="exchange-option-hint">{opt.hint}</span>
                </div>
                <div className={`exchange-option-check ${isActive ? 'visible' : ''}`}>
                  <Check size={14} />
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Изолированный gate: подписан ТОЛЬКО на флаг показа модалки.
// App не подписан на этот флаг и не ре-рендерится при открытии/закрытии,
// благодаря чему ChartGrid не дёргается.
export function ExchangeModalGate() {
  const show = useUIStore(s => s.showExchangeModal)
  if (!show) return null
  return <ExchangeModal />
}
