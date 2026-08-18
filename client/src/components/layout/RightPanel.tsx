import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { List, Bell, Layers, type LucideIcon } from 'lucide-react'
import { CoinList } from '../coinlist/CoinList'
import { AlertStack } from '../alerts/AlertStack'
import { DensityPanel } from '../density/DensityPanel'
import { RightPanelRail, type RailItem } from './RightPanelRail'
import { RightPanelSplitter } from './RightPanelSplitter'

export type PanelKey = 'tickers' | 'alerts' | 'density'
export type ActivePanels = Record<PanelKey, boolean>

const ACTIVE_KEY = 'rightPanel.active.v1'
const SPLIT_KEY = 'rightPanel.split.v1'

const PANEL_ORDER: PanelKey[] = ['tickers', 'alerts', 'density']

const DEFAULT_ACTIVE: ActivePanels = { tickers: true, alerts: false, density: false }

const MIN_PANEL_PX = 120
const MIN_SPLIT_PERCENT = 5

const PANEL_META: Record<PanelKey, { label: string; icon: LucideIcon }> = {
  tickers: { label: 'Ticker list', icon: List },
  alerts: { label: 'Notifications', icon: Bell },
  density: { label: 'Density map', icon: Layers },
}

const PANEL_COMPONENTS: Record<PanelKey, ComponentType> = {
  tickers: CoinList,
  alerts: AlertStack,
  density: DensityPanel,
}

const RAIL_ITEMS: RailItem[] = PANEL_ORDER.map(key => ({ key, ...PANEL_META[key] }))

function countActive(active: ActivePanels): number {
  return PANEL_ORDER.filter(key => active[key]).length
}

function loadActive(): ActivePanels {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return DEFAULT_ACTIVE
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_ACTIVE
    const next = { ...DEFAULT_ACTIVE }
    for (const key of PANEL_ORDER) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'boolean') next[key] = value
    }
    return countActive(next) > 0 ? next : DEFAULT_ACTIVE
  } catch {
    return DEFAULT_ACTIVE
  }
}

function persistActive(active: ActivePanels): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active))
  } catch {
    void 0
  }
}

function isSplitPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_SPLIT_PERCENT &&
    value <= 100 - MIN_SPLIT_PERCENT
  )
}

function parseStoredSplit(): unknown {
  try {
    return JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null')
  } catch {
    return null
  }
}

function loadSplit(count: number): number[] {
  if (count <= 1) return [100]
  const stored = parseStoredSplit()
  if (count === 2) {
    return isSplitPercent(stored) ? [stored, 100 - stored] : [50, 50]
  }
  if (
    Array.isArray(stored) &&
    stored.length === 2 &&
    isSplitPercent(stored[0]) &&
    isSplitPercent(stored[1]) &&
    stored[0] + stored[1] <= 100 - MIN_SPLIT_PERCENT
  ) {
    return [stored[0], stored[1], 100 - stored[0] - stored[1]]
  }
  return [100 / 3, 100 / 3, 100 / 3]
}

function persistSplit(sizes: number[]): void {
  if (sizes.length < 2) return
  try {
    const value = sizes.length === 2 ? sizes[0] : sizes.slice(0, -1)
    localStorage.setItem(SPLIT_KEY, JSON.stringify(value))
  } catch {
    void 0
  }
}

interface DragState {
  index: number
  startY: number
  height: number
  startSizes: number[]
  minPx: number
}

const roundPercent = (value: number): number => Math.round(value * 100) / 100

export const RightPanel = memo(function RightPanel({ width }: { width: number }) {
  const [active, setActive] = useState<ActivePanels>(loadActive)
  const [sizesState, setSizesState] = useState<number[]>(() => loadSplit(countActive(active)))
  const contentRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  const activeList = useMemo(() => PANEL_ORDER.filter(key => active[key]), [active])

  const sizes = useMemo(() => {
    if (sizesState.length === activeList.length) return sizesState
    return loadSplit(activeList.length)
  }, [sizesState, activeList.length])

  useEffect(() => {
    persistActive(active)
  }, [active])

  const togglePanel = useCallback((key: PanelKey) => {
    setActive(prev => {
      const next = { ...prev, [key]: !prev[key] }
      return countActive(next) > 0 ? next : prev
    })
  }, [])

  const handleSplitterDown = useCallback(
    (index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
      const height = contentRef.current?.clientHeight ?? 0
      if (height <= 0) return
      e.preventDefault()
      const panelCount = activeList.length
      const minPx =
        MIN_PANEL_PX * panelCount <= height ? MIN_PANEL_PX : Math.max(24, Math.floor(height / (panelCount * 2)))
      dragRef.current = { index, startY: e.clientY, height, startSizes: sizes, minPx }
    },
    [activeList.length, sizes],
  )

  const handleSplitterMove = useCallback((index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.index !== index) return
    const { startY, height, startSizes, minPx } = drag
    const pairSum = startSizes[index] + startSizes[index + 1]
    const pairPx = (pairSum / 100) * height
    const startPx = (startSizes[index] / 100) * height
    const maxPx = Math.max(minPx, pairPx - minPx)
    const nextPx = Math.min(Math.max(startPx + e.clientY - startY, minPx), maxPx)
    const next = [...startSizes]
    next[index] = roundPercent((nextPx / height) * 100)
    next[index + 1] = roundPercent(pairSum - next[index])
    setSizesState(next)
  }, [])

  const handleSplitterEnd = useCallback(
    (index: number) => () => {
      if (!dragRef.current || dragRef.current.index !== index) return
      dragRef.current = null
      persistSplit(sizes)
    },
    [sizes],
  )

  const handleSplitterReset = useCallback(
    (index: number) => () => {
      const next = [...sizes]
      const pairSum = next[index] + next[index + 1]
      next[index] = roundPercent(pairSum / 2)
      next[index + 1] = roundPercent(pairSum - next[index])
      setSizesState(next)
      persistSplit(next)
    },
    [sizes],
  )

  return (
    <div className="h-full flex bg-[#0a0a0a] flex-shrink-0" style={{ width }}>
      <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
        <div ref={contentRef} className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {activeList.map((key, index) => {
            const Panel = PANEL_COMPONENTS[key]
            return (
              <Fragment key={key}>
                <div
                  className="min-h-0 overflow-hidden"
                  style={{ height: `${sizes[index]}%` }}
                  data-testid={`panel-${key}`}
                >
                  <Panel />
                </div>
                {index < activeList.length - 1 && (
                  <RightPanelSplitter
                    onPointerDown={handleSplitterDown(index)}
                    onPointerMove={handleSplitterMove(index)}
                    onPointerUp={handleSplitterEnd(index)}
                    onPointerCancel={handleSplitterEnd(index)}
                    onDoubleClick={handleSplitterReset(index)}
                  />
                )}
              </Fragment>
            )
          })}
        </div>
      </div>
      <RightPanelRail items={RAIL_ITEMS} active={active} onToggle={togglePanel} />
    </div>
  )
})
