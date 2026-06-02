import { useAuthStore, useUIStore } from '../../store'
import { X, User, LogOut } from 'lucide-react'

export default function ProfileModal() {
  const { username, telegramVerified, logout } = useAuthStore()
  const { setShowProfile } = useUIStore()

  const handleLogout = async () => {
    await logout()
    setShowProfile(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowProfile(false)}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-white">Личный кабинет</h2>
          <button onClick={() => setShowProfile(false)} className="text-zinc-500 hover:text-white transition">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <User size={18} className="text-zinc-500" />
            <span className="text-white">{username}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-zinc-500 text-sm">Telegram:</span>
            <span className={telegramVerified ? 'text-green-400' : 'text-red-400'}>
              {telegramVerified ? 'привязан' : 'не привязан'}
            </span>
          </div>

          <div className="pt-4 border-t border-zinc-700">
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-red-400 hover:text-red-300 text-sm transition"
            >
              <LogOut size={16} />
              Выйти
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
