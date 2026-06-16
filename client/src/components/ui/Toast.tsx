import { useToastStore } from '../../store/toast'

export function ToastContainer() {
  const toasts = useToastStore(s => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="bg-[#1a1a1a] border border-[#333] text-[#e0e0e0] px-4 py-2 rounded-[6px] text-sm shadow-lg animate-in fade-in slide-in-from-bottom-2"
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
