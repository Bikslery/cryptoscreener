import { useEffect, useRef, useState, useMemo } from 'react'
import { useCoinListStore } from '../../store'
import { wsOnMessage } from '../../services/ws'
import type { DensityCell, UnifiedDepth } from '../../types.js'
import { formatPrice, formatCompact, extractBaseAsset } from '../../utils/format'
import { debounce } from '../../utils/debounce'

function getMarketCapTier(quoteVolume: number): 'large' | 'medium' | 'small' {
  if (quoteVolume > 1e9) return 'large'
  if (quoteVolume > 1e7) return 'medium'
  return 'small'
}

function getDistancePct(price: number, level: number): number {
  return Math.abs((level - price) / price) * 100
}

function exchangeLabel(ex: string): string {
  if (ex.includes('binance') && ex.includes('futures')) return 'BI-F'
  if (ex.includes('binance') && ex.includes('spot')) return 'BI-S'
  if (ex.includes('bybit')) return 'BY-F'
  if (ex.includes('okx') && ex.includes('futures')) return 'OK-F'
  if (ex.includes('okx') && ex.includes('spot')) return 'OK-S'
  return 'EX'
}

const TIER_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  large: { bg: 'bg-[#26a65b]/12', border: 'border-[#26a65b]/25', text: 'text-[#26a65b]' },
  medium: { bg: 'bg-[#3b82f6]/12', border: 'border-[#3b82f6]/25', text: 'text-[#3b82f6]' },
  small: { bg: 'bg-[#555]/8', border: 'border-[#555]/25', text: 'text-[#888]' },
}

export function DensityMap() {
  const selectCoin = useCoinListStore(s => s.selectCoin)
  const coins = useCoinListStore(s => s.coins)
  const coinsRef = useRef(coins)
  coinsRef.current = coins
  const [cells, setCells] = useState<DensityCell[]>([])
  const [thresholdPct, setThresholdPct] = useState<1 | 2>(1)
  const pendingCellsRef = useRef<DensityCell[]>([])
  const flushCells = useMemo(() => debounce(() => {
    setCells(pendingCellsRef.current)
  }, 200), [])

  useEffect(() => {
    const unsub = wsOnMessage((msg) => {
      if (msg.type === 'depth' && msg.data) {
        const depth = msg.data as UnifiedDepth
        const ticker = coinsRef.current.find(c => c.symbol === depth.symbol)
        if (!ticker) return

        const threshold = ticker.quoteVolume24h * (thresholdPct * 0.001)
        const newCells: DensityCell[] = []

        for (const [price, qty] of depth.bids) {
          if (qty * price >= threshold) {
            newCells.push({
              symbol: depth.symbol,
              exchange: depth.exchange,
              side: 'bid',
              price,
              volume: qty * price,
              distancePct: getDistancePct(ticker.price, price),
              marketCap: getMarketCapTier(ticker.quoteVolume24h),
              pricePrecision: ticker.pricePrecision,
            })
          }
        }

        for (const [price, qty] of depth.asks) {
          if (qty * price >= threshold) {
            newCells.push({
              symbol: depth.symbol,
              exchange: depth.exchange,
              side: 'ask',
              price,
              volume: qty * price,
              distancePct: getDistancePct(ticker.price, price),
              marketCap: getMarketCapTier(ticker.quoteVolume24h),
              pricePrecision: ticker.pricePrecision,
            })
          }
        }

        // Merge: replace cells for this symbol, keep others
        const without = pendingCellsRef.current.filter(c => c.symbol !== depth.symbol)
        pendingCellsRef.current = [...without, ...newCells]
        flushCells()
      }
    })

    return unsub
  }, [thresholdPct, flushCells])

  const sorted = useMemo(() => [...cells].sort((a, b) => b.volume - a.volume).slice(0, 50), [cells])

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* Threshold toggles */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1f1f1f]">
        <span className="text-[10px] text-[#555] uppercase tracking-wider">Порог</span>
        <div className="flex items-center gap-[2px]">
          {[1, 2].map(pct => (
            <button
              key={pct}
              className={`clinic-btn clinic-btn-sm text-[10px] h-[22px] px-2 ${
                thresholdPct === pct ? 'clinic-btn-exchange-active' : 'clinic-btn-secondary'
              }`}
              onClick={() => setThresholdPct(pct as 1 | 2)}
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#1f1f1f]">
        <span className="text-[9px] px-1.5 py-0.5 rounded border border-[#26a65b]/30 bg-[#26a65b]/10 text-[#26a65b]">Большие</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded border border-[#3b82f6]/30 bg-[#3b82f6]/10 text-[#3b82f6]">Средние</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded border border-[#555]/30 bg-[#555]/10 text-[#888]">Малые</span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {sorted.map(cell => {
          const style = TIER_STYLES[cell.marketCap] || TIER_STYLES.small
          return (
            <div
              key={`${cell.symbol}-${cell.price}-${cell.side}`}
              className={`flex items-center justify-between px-2.5 py-1.5 rounded-[6px] border cursor-pointer hover:brightness-110 transition-all ${style.bg} ${style.border}`}
              onClick={() => selectCoin(cell.symbol)}
              title={`${cell.symbol} ${cell.side.toUpperCase()} $${formatCompact(cell.volume)} @ ${formatPrice(cell.price, cell.pricePrecision)} (${cell.distancePct.toFixed(2)}%)`}
            >
              <span className="text-[9px] text-[#555] font-mono">{exchangeLabel(cell.exchange)}</span>
              <span className="font-bold text-[11px] text-[#e5e5e5]">{extractBaseAsset(cell.symbol)}</span>
              <span className="font-mono text-[10px] text-[#888]">${formatCompact(cell.volume)}</span>
            </div>
          )
        })}
        {sorted.length === 0 && (
          <div className="text-center py-8 text-[#333] text-[11px]">Ожидание данных плотности...</div>
        )}
      </div>
    </div>
  )
}
