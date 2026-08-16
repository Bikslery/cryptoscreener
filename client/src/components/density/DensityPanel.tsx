import { memo, useState } from 'react'
import { DensityList } from './DensityList'
import { DensityMap } from './DensityMap'

type Mode = 'list' | 'map'

/**
 * Панель плотностей: список плотностей текущей монеты (режим «Список»)
 * или двумерная карта всех плотностей по тирам и расстоянию («Карта»).
 */
export const DensityPanel = memo(function DensityPanel() {
  const [mode, setMode] = useState<Mode>('list')

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-[4px] h-[30px] px-[6px] border-b border-[#1f1f1f] bg-[#0e0e0e] flex-shrink-0 select-none">
        {(['list', 'map'] as Mode[]).map(m => (
          <button
            key={m}
            className={`px-[10px] py-[3px] rounded-[3px] text-[10px] font-medium cursor-pointer transition-colors ${
              mode === m
                ? 'bg-[#242424] text-white'
                : 'text-[#777] hover:text-[#aaa] hover:bg-[#181818]'
            }`}
            onClick={() => setMode(m)}
          >
            {m === 'list' ? 'Список' : 'Карта'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {mode === 'list' ? <DensityList /> : <DensityMap />}
      </div>
    </div>
  )
})
