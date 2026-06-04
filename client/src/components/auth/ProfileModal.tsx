import { useState, useEffect, useRef } from 'react'
import { useAuthStore, useUIStore } from '../../store'
import api from '../../services/api'
import { X, User, LogOut, Shield, KeyRound } from 'lucide-react'
import './ProfileModal.css'

type ResetStep = 'idle' | 'code' | 'password' | 'done'

export default function ProfileModal() {
  const { username, telegramVerified, userId, logout } = useAuthStore()
  const { setShowProfile } = useUIStore()

  // Password reset inline flow
  const [resetStep, setResetStep] = useState<ResetStep>('idle')
  const [resetCode, setResetCode] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetLoading, setResetLoading] = useState(false)
  const [codeTimer, setCodeTimer] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    return () => stopTimer()
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

  const handleLogout = async () => {
    await logout()
    setShowProfile(false)
  }

  const handleResetStart = async () => {
    setResetError('')
    setResetLoading(true)
    try {
      const res = await api.post('/auth/reset-request', { userId })
      setCodeTimer(300)
      setResetStep('code')
    } catch (err: any) {
      setResetError(err.response?.data?.error || 'Ошибка отправки кода')
    } finally {
      setResetLoading(false)
    }
  }

  const handleResetResend = async () => {
    setResetError('')
    try {
      await api.post('/auth/reset-request', { userId })
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
      const res = await api.post('/auth/reset-verify', { userId, code: resetCode })
      setResetToken(res.data.resetToken)
      setResetStep('password')
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
      setResetStep('done')
    } catch (err: any) {
      setResetError(err.response?.data?.error || 'Ошибка смены пароля')
    } finally {
      setResetLoading(false)
    }
  }

  const resetToIdle = () => {
    setResetStep('idle')
    setResetCode('')
    setResetToken('')
    setNewPassword('')
    setNewPassword2('')
    setResetError('')
    setCodeTimer(0)
  }

  const formatTimer = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  const canChangePassword = telegramVerified

  return (
    <div className="profile-overlay" onClick={() => setShowProfile(false)}>
      <div className="profile-backdrop" />
      <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="profile-header">
          <div className="profile-avatar">
            {username?.[0]?.toUpperCase() || '?'}
          </div>
          <div className="profile-header-info">
            <div className="profile-name">{username}</div>
            <div className="profile-role">пользователь</div>
          </div>
          <button className="profile-close" onClick={() => setShowProfile(false)}>
            <X size={14} />
          </button>
        </div>

        {/* Account section */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <User size={14} />
            </div>
            <h2>Аккаунт</h2>
          </div>

          <div className="profile-field">
            <label>Логин</label>
            <span className="field-value">{username}</span>
          </div>

          <div className="profile-field">
            <label>Telegram</label>
            <span className={`profile-badge ${telegramVerified ? 'verified' : 'unverified'}`}>
              <span className="profile-badge-dot" />
              {telegramVerified ? 'привязан' : 'не привязан'}
            </span>
          </div>
        </div>

        {/* Actions section */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <Shield size={14} />
            </div>
            <h2>Действия</h2>
          </div>

          {/* Change password — idle state: just a button */}
          {resetStep === 'idle' && (
            <button
              className={`profile-action-btn ${!canChangePassword ? 'disabled' : ''}`}
              onClick={canChangePassword ? handleResetStart : undefined}
              disabled={!canChangePassword || resetLoading}
              title={!canChangePassword ? 'Сначала привяжите Telegram' : undefined}
            >
              <KeyRound size={15} />
              сменить пароль
              {!canChangePassword && <span className="profile-action-hint">привяжите Telegram</span>}
            </button>
          )}

          {/* Change password — code step */}
          {resetStep === 'code' && (
            <div className="profile-reset-inline">
              <div className="profile-reset-title">введите код из Telegram</div>

              {resetError && <div className="profile-reset-error">{resetError}</div>}

              <form onSubmit={handleResetVerify}>
                <input
                  type="text"
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="profile-reset-code-input"
                  autoFocus
                  inputMode="numeric"
                />

                {codeTimer > 0 && (
                  <p className="profile-reset-timer">Код действителен {formatTimer(codeTimer)}</p>
                )}

                <div className="profile-reset-actions">
                  <button type="button" className="profile-reset-cancel" onClick={resetToIdle}>
                    отмена
                  </button>
                  <button
                    type="submit"
                    disabled={resetLoading || resetCode.length !== 6}
                    className="profile-reset-confirm"
                  >
                    {resetLoading ? '...' : 'подтвердить'}
                  </button>
                </div>
              </form>

              {codeTimer === 0 && (
                <button className="profile-reset-resend" onClick={handleResetResend}>
                  отправить повторно
                </button>
              )}
            </div>
          )}

          {/* Change password — new password step */}
          {resetStep === 'password' && (
            <div className="profile-reset-inline">
              <div className="profile-reset-title">новый пароль</div>

              {resetError && <div className="profile-reset-error">{resetError}</div>}

              <form onSubmit={handleResetPassword}>
                <div className="profile-reset-field">
                  <label>Пароль</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="пароль"
                    autoFocus
                  />
                </div>

                <div className="profile-reset-field">
                  <label>Подтверждение</label>
                  <input
                    type="password"
                    value={newPassword2}
                    onChange={(e) => setNewPassword2(e.target.value)}
                    placeholder="пароль"
                  />
                </div>

                <div className="profile-reset-actions">
                  <button type="button" className="profile-reset-cancel" onClick={resetToIdle}>
                    отмена
                  </button>
                  <button
                    type="submit"
                    disabled={resetLoading || !newPassword || !newPassword2}
                    className="profile-reset-confirm"
                  >
                    {resetLoading ? '...' : 'сменить пароль'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Change password — done */}
          {resetStep === 'done' && (
            <div className="profile-reset-inline">
              <div className="profile-reset-done-text">Пароль изменён</div>
              <button className="profile-reset-confirm" onClick={resetToIdle}>
                готово
              </button>
            </div>
          )}

          <button className="profile-logout-btn" onClick={handleLogout}>
            <LogOut size={15} />
            выйти
          </button>
        </div>
      </div>
    </div>
  )
}
