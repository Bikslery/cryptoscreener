import { useState, memo } from 'react'
import { CoinList } from '../coinlist/CoinList'
import { DensityMap } from '../density/DensityMap'
import { AlertStack } from '../alerts/AlertStack'

type Tab = 'charts' | 'density' | 'alerts'

export const RightPanel = memo(function RightPanel() {
  const [tab, setTab] = useState<Tab>('charts')

  return (
    <div className="w-[400px] h-full flex flex-col bg-[#0a0a0a]">
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
            tab === 'density'
              ? 'text-white border-white text-shadow-[var(--glow-text-strong)]'
              : 'text-[#666] border-transparent hover:text-[#999] hover:border-[rgba(255,255,255,0.1)]'
          }`}
          onClick={() => setTab('density')}
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
        {tab === 'density' && <DensityMap />}
        {tab === 'alerts' && <AlertStack />}
      </div>
    </div>
  )
})
