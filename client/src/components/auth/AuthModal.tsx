import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '../../store'
import api from '../../services/api'
import CursorGlow from '../effects/CursorGlow'
import Particles from '../effects/Particles'
import './AuthModal.css'

type Tab = 'login' | 'register'
type Step = 'form' | 'telegram' | 'success' | 'reset-username' | 'reset-code' | 'reset-password' | 'reset-success'

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
  const [bindError, setBindError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Password reset
  const [resetUsername, setResetUsername] = useState('')
  const [resetUserId, setResetUserId] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetLoading, setResetLoading] = useState(false)
  const [codeTimer, setCodeTimer] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    return () => { stopPolling(); stopTimer() }
  }, [])

  useEffect(() => {
    if (codeTimer <= 0) {
      stopTimer()
      return
    }
    if (!timerRef.current) {
      timerRef.current = setInterval(() => {
        setCodeTimer(prev => {
          if (prev <= 1) { stopTimer(); return 0 }
          return prev - 1
        })
      }, 1000)
    }
  }, [codeTimer])

  const POLL_MAX_ATTEMPTS = 100 // 5 minutes at 3s intervals
  let pollAttempts = 0

  const startPolling = () => {
    stopPolling()
    setBindError('')
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
        if (res.data.telegramBindError) {
          stopPolling()
          setBindError(res.data.telegramBindError)
          return
        }
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

  // ── Password reset handlers ──

  const handleResetRequest = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setResetError('')
    setResetLoading(true)
    try {
      const body = resetUsername ? { username: resetUsername } : { userId: resetUserId }
      const res = await api.post('/auth/reset-request', body)
      setResetUserId(res.data.userId)
      setCodeTimer(300) // 5 min countdown
      setStep('reset-code')
    } catch (err: any) {
      setResetError(err.response?.data?.error || 'Ошибка отправки кода')
    } finally {
      setResetLoading(false)
    }
  }

  const handleResetResend = async () => {
    setResetError('')
    try {
      const body = resetUsername ? { username: resetUsername } : { userId: resetUserId }
      const res = await api.post('/auth/reset-request', body)
      setResetUserId(res.data.userId)
      setCodeTimer(300)
    } catch (err: any) {
      setResetError(err.response?.data?.error || 'Ошибка отправки кода')
    }
  }

  const handleResetVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetError('')
    if (resetCode.length !== 6) {
      setResetError('Введите 6-значный код')
      return
    }
    setResetLoading(true)
    try {
      const res = await api.post('/auth/reset-verify', { userId: resetUserId, code: resetCode })
      setResetToken(res.data.resetToken)
      setStep('reset-password')
    } catch (err: any) {
      setResetError(err.response?.data?.error || 'Неверный код')
    } finally {
      setResetLoading(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetError('')
    if (newPassword.length < 6) {
      setResetError('Пароль должен быть не менее 6 символов')
      return
    }
    if (newPassword !== newPassword2) {
      setResetError('Пароли не совпадают')
      return
    }
    setResetLoading(true)
    try {
      await api.post('/auth/reset-password', { resetToken, password: newPassword })
      setStep('reset-success')
    } catch (err: any) {
      setResetError(err.response?.data?.error || 'Ошибка смены пароля')
    } finally {
      setResetLoading(false)
    }
  }

  const formatTimer = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  const goBackToForm = () => {
    setStep('form')
    setResetError('')
    setResetCode('')
    setNewPassword('')
    setNewPassword2('')
    setResetToken('')
    setCodeTimer(0)
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
            {!bindError && (
              <p className="auth-polling-text">
                Ожидание подтверждения привязки...
              </p>
            )}
            {bindError && (
              <div className="auth-bind-error">
                <div className="auth-bind-error-text">{bindError}</div>
                <button
                  onClick={() => {
                    setBindError('')
                    startPolling()
                  }}
                  className="auth-btn"
                >
                  Попробовать с другим Telegram
                </button>
              </div>
            )}
            {error && !bindError && <div className="auth-error" style={{ marginTop: '1rem' }}>{error}</div>}
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

        {/* --- Reset: enter username --- */}
        {step === 'reset-username' && (
          <div className="auth-step-enter">
            <div className="auth-heading">сброс пароля</div>
            <div className="auth-subtitle">введите логин для отправки кода</div>

            {resetError && <div className="auth-error">{resetError}</div>}

            <form onSubmit={handleResetRequest} className="auth-form">
              <div className="auth-field">
                <label>Логин</label>
                <input
                  type="text"
                  value={resetUsername}
                  onChange={(e) => setResetUsername(e.target.value)}
                  placeholder="логин"
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={resetLoading || !resetUsername}
                className="auth-btn"
              >
                {resetLoading ? '...' : 'отправить код'}
              </button>
            </form>

            <button className="auth-back" onClick={goBackToForm}>
              вернуться ко входу
            </button>
          </div>
        )}

        {/* --- Reset: enter code --- */}
        {step === 'reset-code' && (
          <div className="auth-step-enter">
            <div className="auth-heading">введите код</div>
            <div className="auth-subtitle">код отправлен в ваш Telegram</div>

            {resetError && <div className="auth-error">{resetError}</div>}

            <form onSubmit={handleResetVerify} className="auth-form">
              <div className="auth-field">
                <label>Код подтверждения</label>
                <input
                  type="text"
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="auth-code-input"
                  autoFocus
                  inputMode="numeric"
                />
              </div>

              {codeTimer > 0 && (
                <p className="auth-timer">Код действителен {formatTimer(codeTimer)}</p>
              )}

              <button
                type="submit"
                disabled={resetLoading || resetCode.length !== 6}
                className="auth-btn"
              >
                {resetLoading ? '...' : 'подтвердить'}
              </button>
            </form>

            {codeTimer === 0 && (
              <button className="auth-resend" onClick={handleResetResend}>
                отправить код повторно
              </button>
            )}

            <button className="auth-back" onClick={goBackToForm}>
              вернуться ко входу
            </button>
          </div>
        )}

        {/* --- Reset: new password --- */}
        {step === 'reset-password' && (
          <div className="auth-step-enter">
            <div className="auth-heading">новый пароль</div>
            <div className="auth-subtitle">придумайте новый пароль</div>

            {resetError && <div className="auth-error">{resetError}</div>}

            <form onSubmit={handleResetPassword} className="auth-form">
              <div className="auth-field">
                <label>Пароль</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="пароль"
                  autoFocus
                />
              </div>

              <div className="auth-field">
                <label>Подтверждение пароля</label>
                <input
                  type="password"
                  value={newPassword2}
                  onChange={(e) => setNewPassword2(e.target.value)}
                  placeholder="пароль"
                />
              </div>

              <button
                type="submit"
                disabled={resetLoading || !newPassword || !newPassword2}
                className="auth-btn"
              >
                {resetLoading ? '...' : 'сменить пароль'}
              </button>
            </form>
          </div>
        )}

        {/* --- Reset: success --- */}
        {step === 'reset-success' && (
          <div className="auth-step-enter">
            <div className="auth-success-heading">Пароль изменён</div>
            <p className="auth-success-text">Войдите с новым паролем.</p>
            <button onClick={goBackToForm} className="auth-btn">
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

              {tab === 'login' && (
                <span
                  className="auth-forgot"
                  onClick={() => { setStep('reset-username'); setResetError(''); setResetUsername('') }}
                >
                  забыли пароль?
                </span>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
