import { memo } from 'react'
import { Minus, TrendingUp, Slash, Trash2 } from 'lucide-react'
import type { DrawingTool } from './useDrawings'

interface DrawingToolsPanelProps {
  activeTool: DrawingTool | null
  setActiveTool: (tool: DrawingTool) => void
  clearAllDrawings: () => void
  hasDrawings: boolean
  pendingPoint: { price: number; time: number } | null
}

const TOOLS: { id: DrawingTool; icon: typeof Minus; label: string }[] = [
  { id: 'h-ray', icon: Minus, label: 'Гориз. луч' },
  { id: 't-ray', icon: TrendingUp, label: 'Тренд. луч' },
  { id: 'segment', icon: Slash, label: 'Отрезок' },
]

const DrawingToolsPanel = memo(function DrawingToolsPanel({
  activeTool,
  setActiveTool,
  clearAllDrawings,
  hasDrawings,
  pendingPoint,
}: DrawingToolsPanelProps) {
  return (
    <div className="absolute left-2 top-1/2 -translate-y-1/2 z-40 flex flex-col gap-[6px] pointer-events-auto">
      <div className="bg-[#222] border border-[#383838] rounded-[6px] p-[5px] flex flex-col gap-[3px]">
        {TOOLS.map(({ id, icon: Icon, label }) => {
          const isActive = activeTool === id
          return (
            <button
              key={id}
              className={`flex items-center justify-center w-[30px] h-[30px] rounded-[4px] transition-all duration-150 ${
                isActive
                  ? 'bg-[#3a3a3a] border border-[#505050]'
                  : 'bg-transparent border border-transparent hover:bg-[#2a2a2a]'
              }`}
              onClick={() => setActiveTool(id)}
              title={label}
            >
              <Icon size={14} color={isActive ? '#ddd' : '#555'} strokeWidth={isActive ? 2 : 1.5} />
            </button>
          )
        })}
        {hasDrawings && (
          <>
            <div className="h-[1px] bg-[#383838] mx-[3px]" />
            <button
              className="flex items-center justify-center w-[30px] h-[30px] rounded-[4px] transition-all duration-150 bg-transparent border border-transparent hover:bg-[#2a2a2a] hover:text-[#e74c3c] group"
              onClick={clearAllDrawings}
              title="Удалить все"
            >
              <Trash2 size={13} color="#555" strokeWidth={1.5} className="group-hover:text-[#e74c3c]" />
            </button>
          </>
        )}
      </div>

      {pendingPoint && (
        <div className="bg-[#222] border border-[#444] rounded-[4px] px-[8px] py-[4px] text-[10px] text-[#999] font-mono">
          1-я точка: {pendingPoint.price.toFixed(2)}
        </div>
      )}
    </div>
  )
})

export default DrawingToolsPanel
