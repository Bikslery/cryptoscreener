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
 * Fired-alert popup styled after the scalpboard AlertCard: mono card with a
 * thin colored left bar, small type label + X in the header, big ticker with
 * an accent suffix, details line, and a count badge bottom-right.
 */
function AlertCard({ id, data, count, onClose }: {
  id: number
  data: AlertToastData
  count: number
  onClose: (id: number, closeAll: boolean) => void
}) {
  return (
    <div className="pointer-events-auto relative w-[320px] font-mono rounded-[6px] border border-[#262626] bg-[#171717] shadow-[0_8px_24px_rgba(0,0,0,0.55)] overflow-hidden animate-in fade-in slide-in-from-bottom-2 transition-colors duration-150 hover:bg-[#1b1b1b]">
      <div className="flex">
        <div className={`w-2 self-stretch shrink-0 ${BAR[data.type] ?? BAR.price}`} />
        <div className="flex-1 min-w-0 relative pl-4 pr-4 pt-7 pb-6">
          <div className="flex items-center justify-between mb-6">
            <span className="text-[14px] text-[#d4d4d4]">{data.label}</span>
            <button
              className="w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[#d4d4d4] transition-colors duration-150 hover:bg-white/[0.05]"
              title="Закрыть (Ctrl+клик — закрыть все)"
              data-testid="alert-toast-close"
              onClick={(e) => {
                e.stopPropagation()
                onClose(id, e.ctrlKey || e.metaKey)
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-[36px] font-bold text-[#d4d4d4] leading-none">{data.symbol}</span>
            {data.accent && (
              <span className={`text-[20px] font-bold leading-none ${ACCENT[data.accentTone] ?? ACCENT.neutral}`}>
                {data.accent}
              </span>
            )}
          </div>
          <div className="mt-3 pr-7 text-[14px] text-[#d4d4d4]/80 truncate">{data.sub}</div>
        </div>
      </div>
      {count > 1 && (
        <span className="absolute bottom-3 right-3 text-[13px] text-[#525252]">{count}</span>
      )}
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
        <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 pointer-events-none">
          {(() => {
            const counts = typeCounts(right)
            return right.map((toast) => (
              <AlertCard
                key={toast.id}
                id={toast.id}
                data={toast.alertData!}
                count={counts.get(toast.alertData?.type ?? 'price') ?? 1}
                onClose={handleClose}
              />
            ))
          })()}
        </div>
      )}

      {left.length > 0 && (
        <div className="fixed bottom-5 left-5 z-[100] flex flex-col gap-2 pointer-events-none">
          {(() => {
            const counts = typeCounts(left)
            return left.map((toast) => (
              <AlertCard
                key={toast.id}
                id={toast.id}
                data={toast.alertData!}
                count={counts.get(toast.alertData?.type ?? 'price') ?? 1}
                onClose={handleClose}
              />
            ))
          })()}
        </div>
      )}
    </>
  )
}
