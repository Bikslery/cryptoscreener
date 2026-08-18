import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '../../store'
import api from '../../services/api'
import CursorGlow from '../effects/CursorGlow'
import Particles from '../effects/Particles'
import { apiErrorText } from '../../utils/apiError'
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
  const pollAttemptsRef = useRef(0)

  const startPolling = () => {
    stopPolling()
    setBindError('')
    pollAttemptsRef.current = 0
    pollRef.current = setInterval(async () => {
      pollAttemptsRef.current++
      if (pollAttemptsRef.current > POLL_MAX_ATTEMPTS) {
        stopPolling()
        setError('Timeout expired. Refresh the page and try again.')
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
    } catch (err) {
      setError(apiErrorText(err, 'Registration failed'))
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
      // Telegram is mandatory: an unverified account is sent straight to the
      // bind screen instead of the app.
      if (!res.data.user.telegramVerified) {
        setUsername('')
        setPassword('')
        sessionStorage.setItem('pendingUser', JSON.stringify(res.data.user))
        try {
          const statusRes = await api.get('/auth/telegram-status')
          setTelegramLink(statusRes.data.telegramLink)
        } catch {
          // Non-fatal: polling will retry and get a fresh link
        }
        setStep('telegram')
        startPolling()
        return
      }
      setUser(res.data.user)
      setUsername('')
      setPassword('')
    } catch (err) {
      setError(apiErrorText(err, 'Login failed'))
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
    } catch (err) {
      setResetError(apiErrorText(err, 'Failed to send code'))
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
    } catch (err) {
      setResetError(apiErrorText(err, 'Failed to send code'))
    }
  }

  const handleResetVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetError('')
    if (resetCode.length !== 6) {
      setResetError('Enter the 6-digit code')
      return
    }
    setResetLoading(true)
    try {
      const res = await api.post('/auth/reset-verify', { userId: resetUserId, code: resetCode })
      setResetToken(res.data.resetToken)
      setStep('reset-password')
    } catch (err) {
      setResetError(apiErrorText(err, 'Invalid code'))
    } finally {
      setResetLoading(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetError('')
    if (newPassword.length < 6) {
      setResetError('Password must be at least 6 characters')
      return
    }
    if (newPassword !== newPassword2) {
      setResetError('Passwords do not match')
      return
    }
    setResetLoading(true)
    try {
      await api.post('/auth/reset-password', { resetToken, password: newPassword })
      setStep('reset-success')
    } catch (err) {
      setResetError(apiErrorText(err, 'Failed to change password'))
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
            <div className="auth-heading">Link Telegram</div>
            <p className="auth-telegram-text">
              To complete registration, link your Telegram account
            </p>
            <p className="auth-telegram-hint">
              Click the button below, open the bot and send <code>/start</code>
            </p>
            <a
              href={telegramLink}
              target="_blank"
              rel="noopener noreferrer"
              className="auth-telegram-link"
            >
              Open Telegram
            </a>
            {!bindError && (
              <p className="auth-polling-text">
                Waiting for binding confirmation...
              </p>
            )}
            {bindError && (
              <div className="auth-bind-error">
                <div className="auth-bind-error-text">{bindError}</div>
              </div>
            )}
            {error && !bindError && <div className="auth-error" style={{ marginTop: '1rem' }}>{error}</div>}
          </div>
        )}

        {/* --- Success screen --- */}
        {step === 'success' && (
          <div className="auth-step-enter">
            <div className="auth-success-heading">You have successfully created an account</div>
            <p className="auth-success-text">Welcome.</p>
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
              Sign in
            </button>
          </div>
        )}

        {/* --- Reset: enter username --- */}
        {step === 'reset-username' && (
          <div className="auth-step-enter">
            <div className="auth-heading">password reset</div>
            <div className="auth-subtitle">enter your login to send the code</div>

            {resetError && <div className="auth-error">{resetError}</div>}

            <form onSubmit={handleResetRequest} className="auth-form">
              <div className="auth-field">
                <label>Login</label>
                <input
                  type="text"
                  value={resetUsername}
                  onChange={(e) => setResetUsername(e.target.value)}
                  placeholder="login"
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={resetLoading || !resetUsername}
                className="auth-btn"
              >
                {resetLoading ? '...' : 'send code'}
              </button>
            </form>

            <button className="auth-back" onClick={goBackToForm}>
              back to sign in
            </button>
          </div>
        )}

        {/* --- Reset: enter code --- */}
        {step === 'reset-code' && (
          <div className="auth-step-enter">
            <div className="auth-heading">enter code</div>
            <div className="auth-subtitle">code sent to your Telegram</div>

            {resetError && <div className="auth-error">{resetError}</div>}

            <form onSubmit={handleResetVerify} className="auth-form">
              <div className="auth-field">
                <label>Confirmation code</label>
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
                <p className="auth-timer">Code valid for {formatTimer(codeTimer)}</p>
              )}

              <button
                type="submit"
                disabled={resetLoading || resetCode.length !== 6}
                className="auth-btn"
              >
                {resetLoading ? '...' : 'confirm'}
              </button>
            </form>

            {codeTimer === 0 && (
              <button className="auth-resend" onClick={handleResetResend}>
                resend code
              </button>
            )}

            <button className="auth-back" onClick={goBackToForm}>
              back to sign in
            </button>
          </div>
        )}

        {/* --- Reset: new password --- */}
        {step === 'reset-password' && (
          <div className="auth-step-enter">
            <div className="auth-heading">new password</div>
            <div className="auth-subtitle">choose a new password</div>

            {resetError && <div className="auth-error">{resetError}</div>}

            <form onSubmit={handleResetPassword} className="auth-form">
              <div className="auth-field">
                <label>Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="password"
                  autoFocus
                />
              </div>

              <div className="auth-field">
                <label>Confirm password</label>
                <input
                  type="password"
                  value={newPassword2}
                  onChange={(e) => setNewPassword2(e.target.value)}
                  placeholder="password"
                />
              </div>

              <button
                type="submit"
                disabled={resetLoading || !newPassword || !newPassword2}
                className="auth-btn"
              >
                {resetLoading ? '...' : 'change password'}
              </button>
            </form>
          </div>
        )}

        {/* --- Reset: success --- */}
        {step === 'reset-success' && (
          <div className="auth-step-enter">
            <div className="auth-success-heading">Password changed</div>
            <p className="auth-success-text">Sign in with the new password.</p>
            <button onClick={goBackToForm} className="auth-btn">
              Sign in
            </button>
          </div>
        )}

        {/* --- Login / Register form --- */}
        {step === 'form' && (
          <div className="auth-step-enter">
            <div className="auth-heading">welcome back</div>
            <div className="auth-subtitle">sign in to continue</div>

            {/* Tabs */}
            <div className="auth-tabs">
              <button
                onClick={() => { setTab('login'); setError('') }}
                className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
              >
                Sign in
              </button>
              <button
                onClick={() => { setTab('register'); setError('') }}
                className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
              >
                Register
              </button>
            </div>

            {error && <div className="auth-error">{error}</div>}

            <form onSubmit={tab === 'login' ? handleLogin : handleRegister} className="auth-form">
              <div className="auth-field">
                <label>Login</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="login"
                  autoFocus
                />
              </div>

              <div className="auth-field">
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                />
              </div>

              {tab === 'register' && (
                <div className="auth-field">
                  <label>Repeat password</label>
                  <input
                    type="password"
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                    placeholder="password"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="auth-btn"
              >
                {loading ? '...' : tab === 'login' ? 'Sign in' : 'Register'}
              </button>

              {tab === 'login' && (
                <span
                  className="auth-forgot"
                  onClick={() => { setStep('reset-username'); setResetError(''); setResetUsername('') }}
                >
                  forgot password?
                </span>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
