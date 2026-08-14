import { useToastStore, type AlertToastData } from '../../store/toast'

/** Left accent bar colors — scalpboard mapping: price yellow, impulse green, listing blue. */
const BAR: Record<string, string> = {
  price: 'bg-[#facc15]',
  impulse: 'bg-[#4ade80]',
  listing: 'bg-[#60a5fa]',
}

const ACCENT: Record<AlertToastData['accentTone'], string> = {
  up: 'text-[#4bd24b]',
  down: 'text-[#d24b4b]',
  neutral: 'text-[#d4d4d4]',
}

/**
 * Fired-alert popup in the scalpboard AlertCard style — em-based sizes on a
 * 16px base (0.4em left bar, 0.9em/1.25em balanced padding on every side so
 * the text block sits centered with clear margins, 0.85em type label,
 * 1.6em ticker, 0.8em sub, 1.5em icon buttons, 0.4em border radius,
 * #262626 border on #171717). Height follows the content — no fixed aspect.
 */
function AlertCard({ id, data, count, onClose }: {
  id: number
  data: AlertToastData
  count: number
  onClose: (id: number, closeAll: boolean) => void
}) {
  return (
    <div className="pointer-events-auto relative w-[280px] text-[16px] font-mono rounded-[0.4em] border border-[#262626] bg-[#171717] shadow-[0_8px_24px_rgba(0,0,0,0.55)] overflow-hidden grid grid-cols-[0.4em_auto] animate-in fade-in slide-in-from-bottom-2 transition-colors duration-150 hover:bg-[#1b1b1b]">
      <div className={`w-full h-full rounded-l-[1rem] ${BAR[data.type] ?? BAR.price}`} />
      <div className="relative flex flex-col justify-center p-[0.9em_1.25em] min-w-0 text-[#d4d4d4]">
        <div className="flex items-center justify-between mb-[0.5em]">
          <span className="text-[0.85em] text-[#d4d4d4] truncate">{data.label}</span>
          <button
            className="w-[1.5em] h-[1.5em] shrink-0 flex items-center justify-center rounded-[0.25em] cursor-pointer text-[#d4d4d4] transition-colors duration-150 hover:bg-[#ffffff0d]"
            title="Close (Ctrl+click — close all)"
            data-testid="alert-toast-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose(id, e.ctrlKey || e.metaKey)
            }}
          >
            <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="flex flex-col gap-[0.5em] min-w-0">
          <div className="flex items-baseline gap-[0.35em]">
            <span className="text-[1.6em] font-bold text-[#d4d4d4] leading-none truncate">{data.symbol}</span>
            {data.accent && (
              <span className={`text-[1.6em] font-bold leading-none shrink-0 ${ACCENT[data.accentTone] ?? ACCENT.neutral}`}>
                {data.accent}
              </span>
            )}
          </div>
          <span className="text-[0.8em] text-[#d4d4d4] truncate">{data.sub}</span>
        </div>
        {count > 1 && (
          <span className="absolute right-0 bottom-0 m-[0.6em] text-[0.8em] text-[#525252]">{count}</span>
        )}
      </div>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore(s => s.toasts)
  const dismiss = useToastStore(s => s.dismiss)
  const dismissAll = useToastStore(s => s.dismissAll)

  if (toasts.length === 0) return null

  const messages = toasts.filter(t => t.kind === 'message')
  const right = toasts.filter(t => t.kind === 'alert' && t.position === 'bottom-right')
  const left = toasts.filter(t => t.kind === 'alert' && t.position === 'bottom-left')

  const handleClose = (id: number, closeAll: boolean) => {
    if (closeAll) dismissAll()
    else dismiss(id)
  }

  const typeCounts = (stack: typeof right): Map<string, number> => {
    const m = new Map<string, number>()
    for (const t of stack) {
      const type = t.alertData?.type ?? 'price'
      m.set(type, (m.get(type) ?? 0) + 1)
    }
    return m
  }

  return (
    <>
      {messages.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none">
          {messages.map((toast) => (
            <div
              key={toast.id}
              className="bg-[#1a1a1a] border border-[#333] text-[#e0e0e0] px-4 py-2 rounded-[6px] text-sm shadow-lg animate-in fade-in slide-in-from-bottom-2"
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}

      {right.length > 0 && (
        <div className="fixed bottom-5 right-5 z-[100] pointer-events-none">
          {(() => {
            const counts = typeCounts(right)
            const toast = right[0]
            return (
              <AlertCard
                key={toast.id}
                id={toast.id}
                data={toast.alertData!}
                count={counts.get(toast.alertData?.type ?? 'price') ?? 1}
                onClose={handleClose}
              />
            )
          })()}
        </div>
      )}

      {left.length > 0 && (
        <div className="fixed bottom-5 left-5 z-[100] pointer-events-none">
          {(() => {
            const counts = typeCounts(left)
            const toast = left[0]
            return (
              <AlertCard
                key={toast.id}
                id={toast.id}
                data={toast.alertData!}
                count={counts.get(toast.alertData?.type ?? 'price') ?? 1}
                onClose={handleClose}
              />
            )
          })()}
        </div>
      )}
    </>
  )
}
