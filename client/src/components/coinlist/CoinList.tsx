import { memo, useCallback, useMemo, useRef, useEffect } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useCoinListStore, useAuthStore } from '../../store'
import type { UnifiedTicker, CoinListColKey } from '../../types'
import { extractBaseAsset } from '../../utils/format'
import { getOrFetchHistory } from '../../services/candle-prefetch'
import { VOLUME_HIGH_THRESHOLD } from '../../constants/volume'
import { NATR_HIGH_THRESHOLD } from '../../constants/natr'
import { resolveIndicators, formatIndicator, COLUMN_META } from '../../services/indicators'

interface ColumnDef {
  key: CoinListColKey
  header: string
  subheader: string
  width: string
}

/**
 * The flag that always sat next to the ticker name. It is the watchlist
 * toggle: click pins the coin to the top of the list (gold when pinned).
 */
function WatchFlag({ watched, onClick }: { watched: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      data-testid="watch-toggle"
      className={`shrink-0 mr-[5px] flex items-center justify-center cursor-pointer transition-colors ${watched ? 'text-[#f5c518]' : 'text-[#3a3a3a] hover:text-[#777]'}`}
      title={watched ? 'Remove from favorites' : 'Add to favorites'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      <svg width="0.7em" height="0.7em" viewBox="0 0 8 8" fill="none" className="inline-block shrink-0">
        <path d="M8 8L5 4L8 0H0V8H8Z" fill="currentColor" />
      </svg>
    </button>
  )
}

function formatVal(key: CoinListColKey, coin: UnifiedTicker): string {
  if (key === 'symbol') return extractBaseAsset(coin.symbol)
  return formatIndicator(key, coin[key])
}

interface RowProps {
  coin: UnifiedTicker
  cols: ColumnDef[]
  isSelected: boolean
  isOnPage: boolean
  isWatched: boolean
  onClick: (symbol: string) => void
  onPrefetch: (symbol: string) => void
  onToggleWatch: (symbol: string) => void
}

export const Row = memo(function Row({ coin, cols, isSelected, isOnPage, isWatched, onClick, onPrefetch, onToggleWatch }: RowProps) {
  const isUp = coin.change24h >= 0
  const bg = isSelected
    ? 'bg-white/[0.10]'
    : isOnPage
      ? 'bg-white/[0.06]'
      : 'hover:bg-white/[0.02]'
  const borderL = isSelected
    ? 'border-l-2 border-l-white'
    : 'border-l-2 border-l-transparent'
  const rowCols = cols.map(c => c.width).join(' ')
  return (
    <div
      className={`grid cursor-pointer transition-colors duration-100 ${bg} ${borderL}`}
      style={{ gridTemplateColumns: rowCols, height: '32px' }}
      onMouseDown={() => onPrefetch(coin.symbol)}
      onClick={() => onClick(coin.symbol)}
    >
      {cols.map((col) => {
        if (col.key === 'symbol') {
          return (
            <div key={col.key} className={`flex items-center justify-center px-2 text-[12px] font-medium ${isSelected ? 'text-white' : 'text-[#e5e5e5]'}`}>
              <WatchFlag watched={isWatched} onClick={(e) => { e.stopPropagation(); onToggleWatch(coin.symbol) }} />
              {formatVal('symbol', coin)}
            </div>
          )
        }
        if (col.key === 'change24h') {
          return (
            <div key={col.key} className={`flex items-center justify-center px-2 text-[12px] font-bold ${isUp ? 'text-[#26a65b]' : 'text-[#e74c3c]'}`}>
              {formatVal('change24h', coin)}%
            </div>
          )
        }
        if (col.key === 'quoteVolume24h') {
          return (
            <div key={col.key} data-testid="vol-cell" className={`flex items-center justify-center px-2 text-[11px] ${coin.quoteVolume24h >= VOLUME_HIGH_THRESHOLD ? 'text-[#fff] font-medium' : 'text-[#a0a0a0]'}`}>
              {formatVal('quoteVolume24h', coin)}
            </div>
          )
        }
        if (col.key === 'natr5m') {
          return (
            <div key={col.key} data-testid="natr-cell" className={`flex items-center justify-center px-2 text-[11px] ${coin.natr5m >= NATR_HIGH_THRESHOLD ? 'text-[#fff] font-medium' : 'text-[#a0a0a0]'}`}>
              {formatVal('natr5m', coin)}
            </div>
          )
        }
        return (
          <div key={col.key} className="flex items-center justify-center px-2 text-[11px] text-[#a0a0a0]">
            {formatVal(col.key, coin)}
          </div>
        )
      })}
    </div>
  )
})

export function CoinList() {
  const sortedCoins = useCoinListStore(s => s.sortedCoins)
  const sortBy = useCoinListStore(s => s.sortBy)
  const sortDir = useCoinListStore(s => s.sortDir)
  const selectedSymbol = useCoinListStore(s => s.selectedSymbol)
  const setSort = useCoinListStore(s => s.setSort)
  const expandChart = useCoinListStore(s => s.expandChart)
  const watchlist = useCoinListStore(s => s.watchlist)
  const toggleWatch = useCoinListStore(s => s.toggleWatch)
  const pageIndex = useCoinListStore(s => s.pageIndex)
  const topChartSymbols = sortedCoins.slice(pageIndex * 9, pageIndex * 9 + 9).map(c => c.symbol)
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const watchSet = useMemo(() => new Set(watchlist), [watchlist])

  const settings = useAuthStore(s => s.settings)
  const cols = useMemo<ColumnDef[]>(() => {
    const { coinList } = resolveIndicators(settings?.indicators)
    return coinList.map(key => ({ key, ...COLUMN_META[key] }))
  }, [settings])
  const rowCols = useMemo(() => cols.map(c => c.width).join(' '), [cols])

  const coinMap = useCoinListStore(s => s.coinMap)
  const onPrefetch = useCallback((symbol: string) => {
    // Pass the exchange so the prefetch and the chart's own loader share one
    // cache key and don't fire duplicate requests.
    getOrFetchHistory(symbol, tf, undefined, coinMap.get(symbol)?.exchange)
  }, [tf, coinMap])

  const pageSet = useMemo(() => new Set(topChartSymbols), [topChartSymbols])
  const highlightActive = expandedSymbol === null

  useEffect(() => {
    if (sortedCoins.length === 0) return
    virtuosoRef.current?.scrollToIndex({ index: pageIndex * 9, align: 'start', behavior: 'smooth' })
  }, [pageIndex, sortedCoins.length])

  const rowRenderer = useCallback((index: number) => {
    const coin = sortedCoins[index]
    const onPage = highlightActive && pageSet.has(coin.symbol)
    return (
      <Row
        key={coin.symbol}
        coin={coin}
        cols={cols}
        isSelected={selectedSymbol === coin.symbol}
        isOnPage={onPage}
        isWatched={watchSet.has(coin.symbol)}
        onClick={expandChart}
        onPrefetch={onPrefetch}
        onToggleWatch={toggleWatch}
      />
    )
  }, [sortedCoins, selectedSymbol, expandChart, pageSet, highlightActive, onPrefetch, watchSet, toggleWatch, cols])

  return (
    <div className="w-full h-full flex flex-col bg-[#0a0a0a]">
      <div
        className="grid border-b border-[#1f1f1f] bg-[#0e0e0e] text-[11px] select-none flex-shrink-0"
        style={{ gridTemplateColumns: rowCols }}
      >
        {cols.map((col, i) => (
          <div
            key={col.key}
            className={`flex flex-col items-center justify-center cursor-pointer hover:text-[#aaa] transition-colors py-1 ${
              i < cols.length - 1 ? 'border-r border-[#1f1f1f]' : ''
            } ${sortBy === col.key ? 'text-[#fff]' : 'text-[#888]'}`}
            style={{ height: '40px' }}
            onClick={() => setSort(col.key)}
          >
            <span className="font-medium text-[11px] leading-tight">
              {col.header}{sortBy === col.key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
            </span>
            {col.subheader && (
              <span className="text-[10px] text-[#555] leading-tight">{col.subheader}</span>
            )}
          </div>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        <Virtuoso
          ref={virtuosoRef}
          totalCount={sortedCoins.length}
          itemContent={rowRenderer}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  )
}
