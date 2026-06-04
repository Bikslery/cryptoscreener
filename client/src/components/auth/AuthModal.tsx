import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '../../store'
import api from '../../services/api'

type Tab = 'login' | 'register'
type Step = 'form' | 'telegram' | 'success'

export default function AuthModal() {
  const { setUser } = useAuthStore()
  const [tab, setTab] = useState<Tab>('login')
  const [step, setStep] = useState<Step>('form')

  // Form fields
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Telegram polling
  const [telegramLink, setTelegramLink] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    return () => stopPolling()
  }, [])

  const POLL_MAX_ATTEMPTS = 100 // 5 minutes at 3s intervals
  let pollAttempts = 0

  const startPolling = () => {
    stopPolling()
    pollAttempts = 0
    pollRef.current = setInterval(async () => {
      pollAttempts++
      if (pollAttempts > POLL_MAX_ATTEMPTS) {
        stopPolling()
        setError('Время ожидания истекло. Обновите страницу и попробуйте снова.')
        return
      }
      try {
        const res = await api.get('/auth/telegram-status')
        if (res.data.telegramVerified) {
          stopPolling()
          setStep('success')
        }
      } catch {
        // ignore network errors, keep polling
      }
    }, 3000)
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
      setError('Username: 3-20 chars, a-zA-Z0-9_')
      return
    }
    if (password.length < 6) {
      setError('Password: at least 6 characters')
      return
    }
    if (password !== password2) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      const res = await api.post('/auth/register', { username, password })
      // Don't call setUser yet — stay in AuthModal until Telegram is bound
      sessionStorage.setItem('pendingUser', JSON.stringify(res.data.user))
      try {
        const statusRes = await api.get('/auth/telegram-status')
        setTelegramLink(statusRes.data.telegramLink)
      } catch {
        // Non-fatal: polling will retry and get a fresh link
      }
      setStep('telegram')
      startPolling()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    setLoading(true)
    try {
      const res = await api.post('/auth/login', { username, password })
      setUser(res.data.user)
      setUsername('')
      setPassword('')
    } catch (err: any) {
      const data = err.response?.data
      setError(data?.error || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-[#0a0a0a]">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-8 w-full max-w-md">

        {/* --- Telegram bind screen (non-closable, mandatory) --- */}
        {step === 'telegram' && (
          <div className="text-center">
            <h2 className="text-xl font-bold text-white mb-4">Привяжите Telegram</h2>
            <p className="text-zinc-400 mb-2">
              Для завершения регистрации необходимо привязать Telegram-аккаунт
            </p>
            <p className="text-zinc-500 text-sm mb-6">
              Нажмите кнопку ниже, откройте бота и напишите <code className="text-blue-400">/start</code>
            </p>
            <a
              href={telegramLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-3 rounded-lg transition mb-4"
            >
              Открыть Telegram
            </a>
            <p className="text-zinc-500 text-sm">
              Ожидание подтверждения привязки...
            </p>
            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
          </div>
        )}

        {/* --- Success screen --- */}
        {step === 'success' && (
          <div className="text-center">
            <h2 className="text-xl font-bold text-green-400 mb-4">Вы успешно создали аккаунт</h2>
            <p className="text-zinc-400 mb-6">Приятного пользования.</p>
            <button
              onClick={() => {
                const pending = sessionStorage.getItem('pendingUser')
                if (pending) {
                  setUser({ ...JSON.parse(pending), telegramVerified: true })
                  sessionStorage.removeItem('pendingUser')
                }
              }}
              className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-3 rounded-lg transition"
            >
              Войти
            </button>
          </div>
        )}

        {/* --- Login / Register form --- */}
        {step === 'form' && (
          <>
            {/* Tabs */}
            <div className="flex mb-6 border-b border-zinc-700">
              <button
                onClick={() => { setTab('login'); setError('') }}
                className={`flex-1 pb-3 text-sm font-semibold transition ${
                  tab === 'login' ? 'text-white border-b-2 border-blue-500' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Вход
              </button>
              <button
                onClick={() => { setTab('register'); setError('') }}
                className={`flex-1 pb-3 text-sm font-semibold transition ${
                  tab === 'register' ? 'text-white border-b-2 border-blue-500' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Регистрация
              </button>
            </div>

            {error && (
              <p className="text-red-400 text-sm mb-4">{error}</p>
            )}

            <form onSubmit={tab === 'login' ? handleLogin : handleRegister}>
              <div className="mb-4">
                <label className="block text-zinc-400 text-sm mb-1">Логин</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-600 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-blue-500"
                  placeholder="username"
                  autoFocus
                />
              </div>

              <div className="mb-4">
                <label className="block text-zinc-400 text-sm mb-1">Пароль</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-600 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-blue-500"
                  placeholder="••••••"
                />
              </div>

              {tab === 'register' && (
                <div className="mb-4">
                  <label className="block text-zinc-400 text-sm mb-1">Повторите пароль</label>
                  <input
                    type="password"
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-600 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-blue-500"
                    placeholder="••••••"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition"
              >
                {loading ? '...' : tab === 'login' ? 'Войти' : 'Зарегистрироваться'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
