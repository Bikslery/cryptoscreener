import { useState, memo, lazy, Suspense } from 'react'
import { CoinList } from '../coinlist/CoinList'
import { AlertStack } from '../alerts/AlertStack'
// Плотности — тяжёлый компонент, который открывается только по клику на
// вкладку; код грузится отдельным чанком при первом открытии, а не в
// основном бандле первой отрисовки.
const DensityMap = lazy(() => import('../density/DensityMap').then(m => ({ default: m.DensityMap })))

type Tab = 'charts' | 'density' | 'alerts'

export const RightPanel = memo(function RightPanel() {
  const [tab, setTab] = useState<Tab>('charts')

  return (
    <div className="w-[480px] h-full flex flex-col bg-[#0a0a0a]">
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
        {tab === 'density' && (
          <Suspense fallback={<div className="text-center py-8 text-[#333] text-[11px]">Загрузка...</div>}>
            <DensityMap />
          </Suspense>
        )}
        {tab === 'alerts' && <AlertStack />}
      </div>
    </div>
  )
})
