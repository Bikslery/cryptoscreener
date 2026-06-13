import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCoinListStore, useUIStore } from '../../store'
import { extractBaseAsset } from '../../utils/format'
import { Search, X } from 'lucide-react'
import './TickerSearchModal.css'

const MAX_RESULTS = 50

function isLetterKey(key: string): boolean {
  return key.length === 1 && /^\p{L}$/u.test(key)
}

export default function TickerSearchModal() {
  const { setShowTickerSearch, tickerSearchQuery, setTickerSearchQuery } = useUIStore()
  const sortedCoins = useCoinListStore(s => s.sortedCoins)
  const expandChart = useCoinListStore(s => s.expandChart)
  const [query, setQuery] = useState(() => tickerSearchQuery)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  // Consume the initial hotkey character on mount, then clear the store value.
  useEffect(() => {
    if (tickerSearchQuery) {
      setQuery(tickerSearchQuery)
      setTickerSearchQuery('')
    }
    inputRef.current?.focus()
  }, [tickerSearchQuery, setTickerSearchQuery])

  const filtered = useMemo(() => {
    const raw = query.trim().toLowerCase()
    if (!raw) return sortedCoins.slice(0, MAX_RESULTS)
    return sortedCoins.filter((coin) => {
      const symbol = coin.symbol.toLowerCase()
      const base = extractBaseAsset(coin.symbol).toLowerCase()
      return symbol.includes(raw) || base.includes(raw)
    }).slice(0, MAX_RESULTS)
  }, [query, sortedCoins])

  // Reset selection when query or results change.
  useEffect(() => {
    setSelectedIndex(0)
  }, [query, filtered.length])

  // Keep selected item visible in the scrollable list.
  useEffect(() => {
    const el = selectedRef.current
    if (!el || !resultsRef.current) return
    const container = resultsRef.current
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    if (elRect.top < containerRect.top) {
      el.scrollIntoView({ block: 'nearest' })
    } else if (elRect.bottom > containerRect.bottom) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const handleSelect = (symbol: string) => {
    expandChart(symbol)
    setShowTickerSearch(false)
  }

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
          handleSelect(coin.symbol)
        }
        return
      }

      // If a letter is typed while the modal is open, focus the input so it
      // lands in the search field (unless the input already has focus).
      if (isLetterKey(e.key) && document.activeElement !== inputRef.current) {
        inputRef.current?.focus()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [filtered, selectedIndex, setShowTickerSearch])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="ticker-search-overlay" onClick={() => setShowTickerSearch(false)}>
      <div className="ticker-search-backdrop" />
      <div className="ticker-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ticker-search-header">
          <div className="ticker-search-header-icon">
            <Search size={16} />
          </div>
          <div className="ticker-search-header-info">
            <div className="ticker-search-title">Поиск тикера</div>
            <div className="ticker-search-subtitle">начните вводить символ или базовый актив</div>
          </div>
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="BTC, ETH, SOL..."
            className="ticker-search-input"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="ticker-search-input-icon">
            <Search size={16} />
          </span>
        </div>

        <div className="ticker-search-results" ref={resultsRef}>
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
                  onClick={() => handleSelect(coin.symbol)}
                  onMouseEnter={() => setSelectedIndex(idx)}
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
