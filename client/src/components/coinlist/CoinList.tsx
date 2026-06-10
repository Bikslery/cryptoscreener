import { memo, useCallback, useMemo, useRef, useEffect } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useCoinListStore } from '../../store'
import type { UnifiedTicker } from '../../types'
import { formatCompact, extractBaseAsset } from '../../utils/format'
import { getOrFetchHistory } from '../../services/candle-prefetch'
import { VOLUME_HIGH_THRESHOLD } from '../../constants/volume'

type ColKey = keyof UnifiedTicker

interface ColumnDef {
  key: ColKey
  header: string
  subheader: string
  width: string
}

const COLS: ColumnDef[] = [
  { key: 'symbol', header: 'Тикер', subheader: '', width: '80px' },
  { key: 'change24h', header: 'ИЗМ', subheader: '24ч', width: '72px' },
  { key: 'range1m', header: 'РЕНЖ', subheader: '1м/5', width: '72px' },
  { key: 'natr5m', header: 'NATR', subheader: '5м/14', width: '72px' },
  { key: 'quoteVolume24h', header: 'ОБЪЁМ', subheader: '24ч', width: '80px' },
]

function ArrowFlag() {
  return (
    <svg width="0.7em" height="0.7em" viewBox="0 0 8 8" fill="none" className="inline-block mr-1 text-[#555] shrink-0">
      <path d="M8 8L5 4L8 0H0V8H8Z" fill="currentColor" />
    </svg>
  )
}

function formatVal(key: ColKey, coin: UnifiedTicker): string {
  const v = coin[key]
  if (key === 'symbol') return extractBaseAsset(v as string)
  if (key === 'change24h') return `${(v as number) >= 0 ? '+' : ''}${(v as number).toFixed(1)}`
  if (key === 'range1m' || key === 'natr5m') return v ? `${(v as number).toFixed(1)}` : '-'
  if (key === 'quoteVolume24h') {
    const n = v as number
    return formatCompact(n)
  }
  return String(v)
}

interface RowProps {
  coin: UnifiedTicker
  isSelected: boolean
  isOnPage: boolean
  isNextOnPage: boolean
  onClick: (symbol: string) => void
  onPrefetch: (symbol: string) => void
}

export const Row = memo(function Row({ coin, isSelected, isOnPage, isNextOnPage, onClick, onPrefetch }: RowProps) {
  const isUp = coin.change24h >= 0
  const bg = isSelected
    ? 'bg-white/[0.10]'
    : isOnPage
      ? 'bg-white/[0.06]'
      : 'hover:bg-white/[0.02]'
  const borderL = isSelected
    ? 'border-l-2 border-l-white'
    : 'border-l-2 border-l-transparent'
  const borderB = isOnPage && isNextOnPage
    ? 'border-b border-white/[0.06]'
    : 'border-b border-[#111]'
  return (
    <div
      className={`grid cursor-pointer transition-colors duration-100 ${bg} ${borderL} ${borderB}`}
      style={{ gridTemplateColumns: '80px 72px 72px 72px 80px', height: '32px', fontFamily: "'JetBrains Mono', monospace" }}
      onMouseDown={() => onPrefetch(coin.symbol)}
      onClick={() => onClick(coin.symbol)}
    >
      <div className={`flex items-center px-2 text-[12px] font-medium border-r border-[#111] ${isSelected ? 'text-white' : 'text-[#e5e5e5]'}`}>
        <ArrowFlag />
        {formatVal('symbol', coin)}
      </div>
      <div className={`flex items-center justify-end px-2 text-[12px] font-bold border-r border-[#111] ${isUp ? 'text-[#26a65b]' : 'text-[#e74c3c]'}`}>
        {formatVal('change24h', coin)}%
      </div>
      <div className="flex items-center justify-end px-2 text-[11px] text-[#a0a0a0] border-r border-[#111]">
        {formatVal('range1m', coin)}
      </div>
      <div className="flex items-center justify-end px-2 text-[11px] text-[#a0a0a0] border-r border-[#111]">
        {formatVal('natr5m', coin)}
      </div>
      <div data-testid="vol-cell" className={`flex items-center justify-end px-2 text-[11px] ${coin.quoteVolume24h >= VOLUME_HIGH_THRESHOLD ? 'text-[#fff] font-medium' : 'text-[#a0a0a0]'}`}>
        {formatVal('quoteVolume24h', coin)}
      </div>
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
  const pageIndex = useCoinListStore(s => s.pageIndex)
  const topChartSymbols = sortedCoins.slice(pageIndex * 9, pageIndex * 9 + 9).map(c => c.symbol)
  const expandedSymbol = useCoinListStore(s => s.expandedSymbol)
  const tf = useCoinListStore(s => s.activeTimeframe)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const onPrefetch = useCallback((symbol: string) => getOrFetchHistory(symbol, tf), [tf])

  const pageSet = useMemo(() => new Set(topChartSymbols), [topChartSymbols])
  const highlightActive = expandedSymbol === null

  useEffect(() => {
    if (sortedCoins.length === 0) return
    virtuosoRef.current?.scrollToIndex({ index: pageIndex * 9, align: 'start', behavior: 'smooth' })
  }, [pageIndex, sortedCoins.length])

  const rowRenderer = useCallback((index: number) => {
    const coin = sortedCoins[index]
    const onPage = highlightActive && pageSet.has(coin.symbol)
    const nextCoin = sortedCoins[index + 1]
    const nextOnPage = highlightActive && !!nextCoin && pageSet.has(nextCoin.symbol)
    return (
      <Row
        key={coin.symbol}
        coin={coin}
        isSelected={selectedSymbol === coin.symbol}
        isOnPage={onPage}
        isNextOnPage={nextOnPage}
        onClick={expandChart}
        onPrefetch={onPrefetch}
      />
    )
  }, [sortedCoins, selectedSymbol, expandChart, pageSet, highlightActive, onPrefetch])

  return (
    <div className="w-[400px] h-full flex flex-col bg-[#0a0a0a]">
      <div
        className="grid border-b border-[#1f1f1f] bg-[#0e0e0e] text-[11px] select-none flex-shrink-0"
        style={{ gridTemplateColumns: '80px 72px 72px 72px 80px', fontFamily: "'JetBrains Mono', monospace" }}
      >
        {COLS.map((col, i) => (
          <div
            key={col.key}
            className={`flex flex-col items-center justify-center cursor-pointer hover:text-[#aaa] transition-colors py-1 ${
              i < COLS.length - 1 ? 'border-r border-[#1f1f1f]' : ''
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
