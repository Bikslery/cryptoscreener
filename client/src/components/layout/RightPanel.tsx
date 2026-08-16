import { useState, memo } from 'react'
import { CoinList } from '../coinlist/CoinList'
import { AlertStack } from '../alerts/AlertStack'
import { DensityPanel } from '../density/DensityPanel'

type Tab = 'charts' | 'map' | 'alerts'

export const RightPanel = memo(function RightPanel({ width }: { width: number }) {
  const [tab, setTab] = useState<Tab>('charts')

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] flex-shrink-0" style={{ width }}>
      {/* Tabs */}
      <div className="flex items-center h-[36px] bg-[#0e0e0e] border-b border-[#1f1f1f] flex-shrink-0 select-none">
        <button
          className={`flex-1 h-full text-[11px] font-medium cursor-pointer border-b-2 transition-all ${
            tab === 'charts'
              ? 'text-white border-white text-shadow-[var(--glow-text-strong)]'
              : 'text-[#666] border-transparent hover:text-[#999] hover:border-[rgba(255,255,255,0.1)]'
          }`}
          onClick={() => setTab('charts')}
        >
          Графики
        </button>
        <button
          className={`flex-1 h-full text-[11px] font-medium cursor-pointer border-b-2 transition-all ${
            tab === 'map'
              ? 'text-white border-white text-shadow-[var(--glow-text-strong)]'
              : 'text-[#666] border-transparent hover:text-[#999] hover:border-[rgba(255,255,255,0.1)]'
          }`}
          onClick={() => setTab('map')}
        >
          Плотности
        </button>
        <button
          className={`flex-1 h-full text-[11px] font-medium cursor-pointer border-b-2 transition-all ${
            tab === 'alerts'
              ? 'text-white border-white text-shadow-[var(--glow-text-strong)]'
              : 'text-[#666] border-transparent hover:text-[#999] hover:border-[rgba(255,255,255,0.1)]'
          }`}
          onClick={() => setTab('alerts')}
        >
          Уведомления
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'charts' && <CoinList />}
        {tab === 'map' && <DensityPanel />}
        {tab === 'alerts' && <AlertStack />}
      </div>
    </div>
  )
})