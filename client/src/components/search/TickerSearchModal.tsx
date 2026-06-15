import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCoinListStore, useUIStore } from '../../store'
import { extractBaseAsset } from '../../utils/format'
import { X } from 'lucide-react'
import './TickerSearchModal.css'

const MAX_RESULTS = 50

export default function TickerSearchModal() {
  const { setShowTickerSearch } = useUIStore()
  const sortedCoins = useCoinListStore(s => s.sortedCoins)
  const expandChart = useCoinListStore(s => s.expandChart)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => {
    const raw = query.trim().toLowerCase()
    if (!raw) return sortedCoins.slice(0, MAX_RESULTS)
    return sortedCoins.filter((coin) => {
      const symbol = coin.symbol.toLowerCase()
      const base = extractBaseAsset(coin.symbol).toLowerCase()
      return symbol.includes(raw) || base.includes(raw)
    }).slice(0, MAX_RESULTS)
  }, [query, sortedCoins])

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setShowTickerSearch(false)
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => (filtered.length === 0 ? 0 : (i + 1) % filtered.length))
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => (filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length))
        return
      }

      if (e.key === 'Enter') {
        const coin = filtered[selectedIndex]
        if (coin) {
          e.preventDefault()
          expandChart(coin.symbol)
          setShowTickerSearch(false)
        }
        return
      }

      if (/[A-Za-z]/.test(e.key) && e.key.length === 1 && document.activeElement !== inputRef.current) {
        inputRef.current?.focus()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [filtered, selectedIndex, setShowTickerSearch, expandChart])

  return createPortal(
    <div className="ticker-search-overlay" onClick={() => setShowTickerSearch(false)}>
      <div className="ticker-search-backdrop" />
      <div className="ticker-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ticker-search-header">
          <div className="ticker-search-title">Поиск тикера</div>
          <button
            className="ticker-search-close"
            onClick={() => setShowTickerSearch(false)}
            aria-label="Закрыть"
          >
            <X size={14} />
          </button>
        </div>

        <div className="ticker-search-input-wrap">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
            placeholder="BTC, ETH, SOL..."
            className="ticker-search-input"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="ticker-search-results">
          {filtered.length === 0 ? (
            <div className="ticker-search-empty">Ничего не найдено</div>
          ) : (
            filtered.map((coin, idx) => {
              const isSelected = idx === selectedIndex
              const base = extractBaseAsset(coin.symbol)
              return (
                <button
                  key={coin.symbol}
                  ref={isSelected ? selectedRef : null}
                  className={`ticker-search-result ${isSelected ? 'selected' : ''}`}
                  onClick={() => { expandChart(coin.symbol); setShowTickerSearch(false) }}
                >
                  <span className="ticker-search-result-symbol">{base}</span>
                  <span className="ticker-search-result-meta">
                    <span>{coin.symbol}</span>
                    <span>{coin.change24h >= 0 ? '+' : ''}{coin.change24h.toFixed(1)}%</span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Изолированный gate: подписан ТОЛЬКО на флаг показа модалки.
// App не подписан на этот флаг и не ре-рендерится при открытии/закрытии,
// благодаря чему ChartGrid не дёргается.
export function TickerSearchModalGate() {
  const show = useUIStore(s => s.showTickerSearch)
  if (!show) return null
  return <TickerSearchModal />
}
