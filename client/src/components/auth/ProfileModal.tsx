import { useState, useEffect } from 'react'
import api from '../../services/api'
import { useAuthStore, useUIStore } from '../../store'

export function ProfileModal() {
  const { email, logout } = useAuthStore()
  const { setShowProfile } = useUIStore()
  const [telegramLink, setTelegramLink] = useState('')
  const [telegramBound, setTelegramBound] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/auth/me')
      .then((res: any) => {
        setTelegramBound(!!res.data.telegramChatId)
        setLoading(false)
      })
      .catch(() => setLoading(false))

    api.get('/auth/telegram-link')
      .then((res: any) => setTelegramLink(res.data.link))
      .catch(() => {})
  }, [])

  const handleUnbind = async () => {
    try {
      await api.post('/auth/telegram-unbind')
      setTelegramBound(false)
    } catch {}
  }

  const handleLogout = () => {
    logout()
    setShowProfile(false)
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowProfile(false)}>
      <div
        className="w-full max-w-sm p-6 bg-[#0e0e0e] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h1 className="text-lg font-bold text-center mb-6 text-white" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          Профиль
        </h1>

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2 border-b border-[#1f1f1f]">
            <span className="text-sm text-[#888]">Email</span>
            <span className="text-sm text-white font-medium">{email}</span>
          </div>

          <div className="py-2 border-b border-[#1f1f1f]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-[#888]">Telegram</span>
              {telegramBound ? (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#26a65b]/15 text-[#26a65b] border border-[#26a65b]/30">Привязан</span>
              ) : (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#555]/15 text-[#888] border border-[#555]/30">Не привязан</span>
              )}
            </div>

            {!loading && !telegramBound && telegramLink && (
              <div className="space-y-2">
                <p className="text-[11px] text-[#888] leading-relaxed">
                  Нажмите кнопку ниже, откройте Telegram и нажмите «Start» для привязки уведомлений.
                </p>
                <a
                  href={telegramLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full py-2 bg-[#f9b600] text-black rounded-lg font-semibold text-sm text-center hover:brightness-110 transition-all"
                >
                  Привязать Telegram
                </a>
              </div>
            )}

            {!loading && telegramBound && (
              <button
                onClick={handleUnbind}
                className="w-full py-2 bg-[#1a1a1a] text-[#e74c3c] rounded-lg font-medium text-sm border border-[#2a2a2a] hover:border-[#e74c3c]/50 transition-colors"
              >
                Отвязать Telegram
              </button>
            )}
          </div>

          <button
            onClick={handleLogout}
            className="w-full py-2 bg-[#e74c3c] text-white rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity"
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  )
}
