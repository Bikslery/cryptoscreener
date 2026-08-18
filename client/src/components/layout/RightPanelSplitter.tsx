import { memo, type PointerEvent as ReactPointerEvent } from 'react'

interface RightPanelSplitterProps {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void
  onDoubleClick: () => void
}

export const RightPanelSplitter = memo(function RightPanelSplitter(props: RightPanelSplitterProps) {
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      void 0
    }
    props.onPointerDown(e)
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-testid="panel-splitter"
      className="flex-shrink-0 cursor-row-resize touch-none select-none flex flex-col justify-center transition-colors"
      style={{ height: '8px', background: 'transparent' }}
      onPointerDown={handlePointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onDoubleClick={props.onDoubleClick}
    >
      <div
        className="w-full"
        style={{
          height: '1px',
          background: '#1a1a1a',
          boxShadow: '0 1px 0 rgba(255,255,255,0.06)',
        }}
      />
    </div>
  )
})
