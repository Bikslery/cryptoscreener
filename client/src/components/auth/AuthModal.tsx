import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '../../store'
import api from '../../services/api'
import CursorGlow from '../effects/CursorGlow'
import Particles from '../effects/Particles'
import './AuthModal.css'

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
    <div className="auth-page">
      <Particles style="white" />
      <CursorGlow />

      <div className="auth-card">

        {/* --- Telegram bind screen (non-closable, mandatory) --- */}
        {step === 'telegram' && (
          <div className="auth-step-enter">
            <div className="auth-heading">Привяжите Telegram</div>
            <p className="auth-telegram-text">
              Для завершения регистрации необходимо привязать Telegram-аккаунт
            </p>
            <p className="auth-telegram-hint">
              Нажмите кнопку ниже, откройте бота и напишите <code>/start</code>
            </p>
            <a
              href={telegramLink}
              target="_blank"
              rel="noopener noreferrer"
              className="auth-telegram-link"
            >
              Открыть Telegram
            </a>
            <p className="auth-polling-text">
              Ожидание подтверждения привязки...
            </p>
            {error && <div className="auth-error" style={{ marginTop: '1rem' }}>{error}</div>}
          </div>
        )}

        {/* --- Success screen --- */}
        {step === 'success' && (
          <div className="auth-step-enter">
            <div className="auth-success-heading">Вы успешно создали аккаунт</div>
            <p className="auth-success-text">Приятного пользования.</p>
            <button
              onClick={() => {
                const pending = sessionStorage.getItem('pendingUser')
                if (pending) {
                  setUser({ ...JSON.parse(pending), telegramVerified: true })
                  sessionStorage.removeItem('pendingUser')
                }
              }}
              className="auth-btn"
            >
              войти
            </button>
          </div>
        )}

        {/* --- Login / Register form --- */}
        {step === 'form' && (
          <div className="auth-step-enter">
            <div className="auth-heading">с возвращением</div>
            <div className="auth-subtitle">войдите в систему для продолжения</div>

            {/* Tabs */}
            <div className="auth-tabs">
              <button
                onClick={() => { setTab('login'); setError('') }}
                className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
              >
                Вход
              </button>
              <button
                onClick={() => { setTab('register'); setError('') }}
                className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
              >
                Регистрация
              </button>
            </div>

            {error && <div className="auth-error">{error}</div>}

            <form onSubmit={tab === 'login' ? handleLogin : handleRegister} className="auth-form">
              <div className="auth-field">
                <label>Логин</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="логин"
                  autoFocus
                />
              </div>

              <div className="auth-field">
                <label>Пароль</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="пароль"
                />
              </div>

              {tab === 'register' && (
                <div className="auth-field">
                  <label>Повторите пароль</label>
                  <input
                    type="password"
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                    placeholder="пароль"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="auth-btn"
              >
                {loading ? '...' : tab === 'login' ? 'войти' : 'зарегистрироваться'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
