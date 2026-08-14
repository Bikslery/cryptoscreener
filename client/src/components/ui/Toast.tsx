import { useToastStore } from '../../store/toast'

const TONE_TEXT: Record<string, string> = {
  up: 'text-[#26a65b]',
  down: 'text-[#e74c3c]',
  neutral: 'text-[#e0e0e0]',
}

const TYPE_BADGE: Record<string, string> = {
  price: 'bg-[#3b82f6]/15 text-[#3b82f6] border-[#3b82f6]/30',
  impulse: 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30',
  listing: 'bg-[#26a65b]/15 text-[#26a65b] border-[#26a65b]/30',
}

function AlertCard({ id, label, symbol, line, tone, onClose }: {
  id: number
  label: string
  symbol: string
  line: string
  tone: string
  onClose: (id: number, closeAll: boolean) => void
}) {
  return (
    <div className="pointer-events-auto relative w-[240px] bg-[#171717] border border-[#2e2e2e] rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.45)] px-2.5 py-2 animate-in fade-in slide-in-from-bottom-2">
      <button
        className="absolute top-1 right-1 w-4 h-4 flex items-center justify-center rounded text-[#777] hover:text-white hover:bg-white/10 transition-colors"
        title="Закрыть (Ctrl+клик — закрыть все)"
        data-testid="alert-toast-close"
        onClick={(e) => {
          e.stopPropagation()
          onClose(id, e.ctrlKey || e.metaKey)
        }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <div className="flex items-center gap-1.5 pr-4">
        <span className={`text-[8px] font-semibold px-1 py-px rounded border ${TYPE_BADGE[label] ?? TYPE_BADGE.price}`}>
          {label.toUpperCase()}
        </span>
        <span className="text-[11px] font-bold text-white truncate">{symbol}</span>
      </div>
      <div className={`text-[10px] font-mono mt-0.5 truncate ${TONE_TEXT[tone] ?? TONE_TEXT.neutral}`}>
        {line}
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
        <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-1.5 pointer-events-none">
          {right.map((toast) => (
            <AlertCard
              key={toast.id}
              id={toast.id}
              label={toast.message}
              symbol={toast.alertData?.symbol ?? ''}
              line={toast.alertData?.line ?? ''}
              tone={toast.alertData?.tone ?? 'neutral'}
              onClose={handleClose}
            />
          ))}
        </div>
      )}

      {left.length > 0 && (
        <div className="fixed bottom-5 left-5 z-[100] flex flex-col gap-1.5 pointer-events-none">
          {left.map((toast) => (
            <AlertCard
              key={toast.id}
              id={toast.id}
              label={toast.message}
              symbol={toast.alertData?.symbol ?? ''}
              line={toast.alertData?.line ?? ''}
              tone={toast.alertData?.tone ?? 'neutral'}
              onClose={handleClose}
            />
          ))}
        </div>
      )}
    </>
  )
}
