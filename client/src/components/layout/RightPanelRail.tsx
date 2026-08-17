import { memo } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ActivePanels, PanelKey } from './RightPanel'

export interface RailItem {
  key: PanelKey
  label: string
  icon: LucideIcon
}

interface RightPanelRailProps {
  items: RailItem[]
  active: ActivePanels
  onToggle: (key: PanelKey) => void
}

export const RightPanelRail = memo(function RightPanelRail({ items, active, onToggle }: RightPanelRailProps) {
  return (
    <div
      className="h-full w-[40px] flex-shrink-0 flex flex-col items-center gap-2 pt-2.5 bg-[#0a0a0a] select-none"
      style={{
        borderLeft: '1px solid #191919',
        boxShadow: 'inset 1px 0 0 rgba(255,255,255,0.03)',
      }}
    >
      {items.map(item => {
        const isActive = active[item.key]
        const Icon = item.icon
        return (
          <div key={item.key} className="relative group">
            <span
              aria-hidden
              className={`absolute left-[-1px] top-1/2 -translate-y-1/2 w-[2px] h-[20px] rounded-r-sm transition-opacity ${isActive ? 'opacity-100' : 'opacity-0'}`}
              style={{
                background: 'rgba(255,255,255,0.88)',
                boxShadow: '0 0 6px 2px rgba(255,255,255,0.25)',
              }}
            />
            <button
              type="button"
              data-testid={`panel-toggle-${item.key}`}
              aria-label={item.label}
              aria-pressed={isActive}
              className={`w-[32px] h-[32px] flex items-center justify-center rounded-[5px] cursor-pointer transition-all duration-150 ${
                isActive
                  ? 'text-white bg-white/[0.07] border border-white/[0.1] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                  : 'text-[#505050] hover:text-[#909090] hover:bg-white/[0.04] border border-transparent hover:border-white/[0.07]'
              }`}
              style={isActive ? { textShadow: 'var(--glow-text-strong)' } : undefined}
              onClick={() => onToggle(item.key)}
            >
              <Icon size={16} strokeWidth={1.5} />
            </button>
            <span className="pointer-events-none absolute right-[calc(100%+8px)] top-1/2 -translate-y-1/2 whitespace-nowrap px-2 py-1 rounded bg-[#161616] border border-[#1f1f1f] text-[10px] text-[#ccc] opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-20">
              {item.label}
            </span>
          </div>
        )
      })}
    </div>
  )
})
