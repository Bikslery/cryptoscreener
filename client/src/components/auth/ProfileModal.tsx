import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAuthStore, useUIStore } from '../../store'
import { useDrawingHotkeysStore, eventToCombo, formatCombo, DRAWING_TOOL_LABELS, DEFAULT_DRAWING_HOTKEYS } from '../../store/drawingHotkeys'
import type { DrawingTool } from '../../types'
import api from '../../services/api'
import { X, User, LogOut, Shield, KeyRound, Keyboard } from 'lucide-react'
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

  const bindings = useDrawingHotkeysStore(s => s.bindings)
  const setBinding = useDrawingHotkeysStore(s => s.setBinding)
  const resetDefaults = useDrawingHotkeysStore(s => s.resetDefaults)
  const [recording, setRecording] = useState<DrawingTool | null>(null)
  const [hotkeyError, setHotkeyError] = useState('')

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
      await api.post('/auth/reset-request', { userId })
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

  const handleHotkeyDown = (tool: DrawingTool, e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    setHotkeyError('')
    if (e.key === 'Escape') {
      setBinding(tool, '').catch(() => setHotkeyError('Не удалось сохранить'))
      setRecording(null)
      return
    }
    const combo = eventToCombo(e.nativeEvent)
    if (!combo) return

    const otherTool = (Object.keys(bindings) as DrawingTool[]).find(
      t => t !== tool && bindings[t] === combo,
    )
    if (otherTool) {
      setHotkeyError(`Комбинация уже используется для ${DRAWING_TOOL_LABELS[otherTool]}`)
      return
    }

    setBinding(tool, combo).catch(() => setHotkeyError('Не удалось сохранить'))
    setRecording(null)
  }

  const handleResetHotkeys = async () => {
    setHotkeyError('')
    try {
      await resetDefaults()
    } catch {
      setHotkeyError('Не удалось сбросить')
    }
  }

  const formatTimer = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  const canChangePassword = telegramVerified

  if (typeof document === 'undefined') return null

  return createPortal(
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

        {/* Hotkeys section */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <Keyboard size={14} />
            </div>
            <h2>Горячие клавиши рисования</h2>
          </div>

          {hotkeyError && <div className="profile-reset-error">{hotkeyError}</div>}

          {(Object.keys(DEFAULT_DRAWING_HOTKEYS) as DrawingTool[]).map((tool) => (
            <div key={tool} className="profile-field">
              <label>{DRAWING_TOOL_LABELS[tool]}</label>
              <input
                type="text"
                readOnly
                value={bindings[tool] ? formatCombo(bindings[tool]) : ''}
                placeholder={recording === tool ? 'Нажмите клавиши...' : 'Нет'}
                className={`profile-hotkey-input ${recording === tool ? 'recording' : ''}`}
                onFocus={() => setRecording(tool)}
                onBlur={() => setRecording(null)}
                onKeyDown={(e) => handleHotkeyDown(tool, e)}
              />
            </div>
          ))}

          <button className="profile-action-btn" onClick={handleResetHotkeys}>
            <Keyboard size={15} />
            сбросить по умолчанию
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Изолированный gate: подписан ТОЛЬКО на флаг показа модалки.
// App не подписан на этот флаг и не ре-рендерится при открытии/закрытии,
// благодаря чему ChartGrid не дёргается.
export function ProfileModalGate() {
  const show = useUIStore(s => s.showProfile)
  if (!show) return null
  return <ProfileModal />
}
