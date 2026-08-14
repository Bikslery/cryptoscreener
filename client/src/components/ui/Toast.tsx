import { useToastStore, type AlertToastData } from '../../store/toast'

const TONE: Record<AlertToastData['tone'], { text: string; strip: string }> = {
  up: { text: 'text-[#26a65b]', strip: 'bg-[#26a65b]' },
  down: { text: 'text-[#e74c3c]', strip: 'bg-[#e74c3c]' },
  neutral: { text: 'text-[#e5e5e5]', strip: 'bg-[#3b82f6]' },
}

const TYPE_BADGE: Record<string, string> = {
  price: 'bg-[#3b82f6]/15 text-[#3b82f6] border-[#3b82f6]/30',
  impulse: 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30',
  listing: 'bg-[#26a65b]/15 text-[#26a65b] border-[#26a65b]/30',
}

const EXCHANGE_BADGE: Record<string, string> = {
  'binance-futures': 'BI-F',
  'binance-spot': 'BI-S',
  'bybit-futures': 'BY-F',
  'okx-spot': 'OK-S',
  'okx-futures': 'OK-F',
}

function AlertCard({ id, data, onClose }: {
  id: number
  data: AlertToastData
  onClose: (id: number, closeAll: boolean) => void
}) {
  const tone = TONE[data.tone] ?? TONE.neutral
  return (
    <div className="pointer-events-auto relative w-[300px] rounded-lg border border-[#2c2c2c] bg-gradient-to-br from-[#1c1c1e] to-[#141416] shadow-[0_8px_24px_rgba(0,0,0,0.55)] p-3.5 overflow-hidden animate-in fade-in slide-in-from-bottom-2">
      <div className={`absolute inset-x-0 top-0 h-[2px] ${tone.strip}`} />
      <button
        className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded text-[#888] hover:text-white hover:bg-white/10 transition-colors"
        title="Закрыть (Ctrl+клик — закрыть все)"
        data-testid="alert-toast-close"
        onClick={(e) => {
          e.stopPropagation()
          onClose(id, e.ctrlKey || e.metaKey)
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <div className="flex items-center gap-1.5 pr-6">
        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${TYPE_BADGE[data.type] ?? TYPE_BADGE.price}`}>
          {data.label.toUpperCase()}
        </span>
        <span className="text-[13px] font-bold text-white truncate">{data.symbol}</span>
        {data.exchange && (
          <span className="text-[9px] font-mono text-[#666]">{EXCHANGE_BADGE[data.exchange] ?? data.exchange}</span>
        )}
      </div>
      <div className={`mt-1.5 font-mono font-bold text-[20px] leading-tight tracking-tight ${tone.text}`}>
        {data.headline}
      </div>
      <div className="mt-0.5 text-[11px] text-[#999] truncate">{data.sub}</div>
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
        <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 pointer-events-none">
          {right.map((toast) => (
            <AlertCard key={toast.id} id={toast.id} data={toast.alertData!} onClose={handleClose} />
          ))}
        </div>
      )}

      {left.length > 0 && (
        <div className="fixed bottom-5 left-5 z-[100] flex flex-col gap-2 pointer-events-none">
          {left.map((toast) => (
            <AlertCard key={toast.id} id={toast.id} data={toast.alertData!} onClose={handleClose} />
          ))}
        </div>
      )}
    </>
  )
}
