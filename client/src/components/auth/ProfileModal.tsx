import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAuthStore, useUIStore } from '../../store'
import { useDrawingHotkeysStore, eventToCombo, formatCombo, DRAWING_TOOL_LABELS, DEFAULT_DRAWING_HOTKEYS } from '../../store/drawingHotkeys'
import type { DrawingTool } from '../../types'
import api from '../../services/api'
import { playAlertSound } from '../../services/alert-notify'
import { X, User, LogOut, Shield, KeyRound, Keyboard, BarChart3, Bell, Volume2, Layers } from 'lucide-react'
import { resolveCascadesConfig } from '../../services/chart-overlays'
import type { CascadesConfig } from '../../types'
import './ProfileModal.css'

type ResetStep = 'idle' | 'code' | 'password' | 'done'

export default function ProfileModal() {
  const { username, telegramVerified, userId, logout, settings, updateSettings } = useAuthStore()
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

  // Chart scale setting — slider with debounced save (range inputs fire many
  // change events per drag; we don't want a PUT per tick).
  const [visibleBars, setVisibleBars] = useState(settings?.chartVisibleBars ?? 450)
  const scaleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setVisibleBars(settings?.chartVisibleBars ?? 450)
  }, [settings?.chartVisibleBars])

  const handleScaleChange = (v: number) => {
    setVisibleBars(v)
    if (scaleSaveTimer.current) clearTimeout(scaleSaveTimer.current)
    scaleSaveTimer.current = setTimeout(() => {
      updateSettings({ chartVisibleBars: v }).catch(() => {})
    }, 400)
  }

  // Alert notification settings — sound on/off + volume (0–1).
  const [notifySound, setNotifySound] = useState(settings?.notifySound !== false)
  const [notifyVolume, setNotifyVolume] = useState(settings?.notifyVolume ?? 1)
  const notifySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setNotifySound(settings?.notifySound !== false)
  }, [settings?.notifySound])

  useEffect(() => {
    setNotifyVolume(settings?.notifyVolume ?? 1)
  }, [settings?.notifyVolume])

  const handleNotifySoundChange = (on: boolean) => {
    setNotifySound(on)
    updateSettings({ notifySound: on }).catch(() => {})
    if (on) playAlertSound(notifyVolume)
  }

  const handleNotifyVolumeChange = (v: number) => {
    setNotifyVolume(v)
    if (notifySaveTimer.current) clearTimeout(notifySaveTimer.current)
    notifySaveTimer.current = setTimeout(() => {
      updateSettings({ notifyVolume: v }).catch(() => {})
    }, 400)
  }

  useEffect(() => {
    return () => {
      if (notifySaveTimer.current) clearTimeout(notifySaveTimer.current)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (scaleSaveTimer.current) clearTimeout(scaleSaveTimer.current)
    }
  }, [])

  // Cascade + density engine config — every parameter of the chart overlays.
  const [cascades, setCascades] = useState<CascadesConfig>(() =>
    resolveCascadesConfig(settings?.cascades),
  )
  const cascadesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setCascades(resolveCascadesConfig(settings?.cascades))
  }, [settings?.cascades])

  const saveCascades = (next: CascadesConfig) => {
    setCascades(next)
    if (cascadesSaveTimer.current) clearTimeout(cascadesSaveTimer.current)
    cascadesSaveTimer.current = setTimeout(() => {
      updateSettings({ cascades: next }).catch(() => {})
    }, 400)
  }

  useEffect(() => {
    return () => {
      if (cascadesSaveTimer.current) clearTimeout(cascadesSaveTimer.current)
    }
  }, [])

  const handleCascadesReset = () => {
    setCascades(resolveCascadesConfig(undefined))
    if (cascadesSaveTimer.current) clearTimeout(cascadesSaveTimer.current)
    updateSettings({ cascades: undefined }).catch(() => {})
  }

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

        {/* Chart settings section */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <BarChart3 size={14} />
            </div>
            <h2>График</h2>
          </div>

          <div className="profile-field">
            <label>Баров на экране при открытии</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={50}
                max={1000}
                step={50}
                value={visibleBars}
                onChange={(e) => handleScaleChange(Number(e.target.value))}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{visibleBars}</span>
            </div>
            <div className="profile-scale-hint">
              Применяется к большому графику при открытии нового символа
            </div>
          </div>
        </div>

        {/* Cascades section — full engine configuration */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <Layers size={14} />
            </div>
            <h2>Каскады</h2>
          </div>

          <div className="profile-field">
            <div className="profile-notify-row">
              <label>Показ каскадов</label>
              <label className="profile-switch">
                <input
                  type="checkbox"
                  checked={cascades.showCascades}
                  onChange={(e) => saveCascades({ ...cascades, showCascades: e.target.checked })}
                  data-testid="cascades-show-toggle"
                />
                <span className="track" />
              </label>
            </div>
          </div>

          <div className="profile-field">
            <label>Минимум уровней в цепочке</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={2}
                max={8}
                step={1}
                value={cascades.minPeaks}
                onChange={(e) => saveCascades({ ...cascades, minPeaks: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.minPeaks}</span>
            </div>
            <div className="profile-scale-hint">Цепочка короче этого не становится каскадом</div>
          </div>

          <div className="profile-field">
            <label>Макс. разрыв цепочки, %</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0.1}
                max={1.5}
                step={0.05}
                value={cascades.maxDistance}
                onChange={(e) => saveCascades({ ...cascades, maxDistance: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.maxDistance}</span>
            </div>
            <div className="profile-scale-hint">Больше — цепочки длиннее и плотнее</div>
          </div>

          <div className="profile-field">
            <label>Окно сравнения, свечей</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={cascades.prominenceWindow}
                onChange={(e) => saveCascades({ ...cascades, prominenceWindow: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.prominenceWindow}</span>
            </div>
            <div className="profile-scale-hint">Экстремум сравнивается с ±N соседними свечами (1 — точно как scalpboard)</div>
          </div>

          <div className="profile-field">
            <label>Мин. значимость, %</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={cascades.minProminencePct}
                onChange={(e) => saveCascades({ ...cascades, minProminencePct: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.minProminencePct}</span>
            </div>
            <div className="profile-scale-hint">Уровень должен выступать минимум на этот % — фильтр шумовых пиков</div>
          </div>

          <div className="profile-field">
            <label>Мин. объём свечи, %</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={cascades.minVolumePct}
                onChange={(e) => saveCascades({ ...cascades, minVolumePct: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.minVolumePct}</span>
            </div>
            <div className="profile-scale-hint">Объём свечи экстремума относительно максимума окна</div>
          </div>

          <div className="profile-field">
            <label>Окно истории, свечей</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0}
                max={3000}
                step={100}
                value={cascades.lookback}
                onChange={(e) => saveCascades({ ...cascades, lookback: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.lookback || 'всё'}</span>
            </div>
            <div className="profile-scale-hint">Учитывать только последние N свечей (0 — всю историю)</div>
          </div>

          <div className="profile-field">
            <label>Лимит каскадов на сторону</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={cascades.maxCascades}
                onChange={(e) => saveCascades({ ...cascades, maxCascades: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.maxCascades || 'без'}</span>
            </div>
            <div className="profile-scale-hint">Ограничивает общее число каскадов (0 — без лимита)</div>
          </div>

          <div className="profile-field">
            <label>Макс. длина цепочки</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={cascades.maxChainLen}
                onChange={(e) => saveCascades({ ...cascades, maxChainLen: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.maxChainLen || 'без'}</span>
            </div>
            <div className="profile-scale-hint">Рвёт слишком длинные каскады (0 — без лимита)</div>
          </div>

          <div className="profile-field">
            <div className="profile-notify-row">
              <label>Подписи уровней</label>
              <label className="profile-switch">
                <input
                  type="checkbox"
                  checked={cascades.showLabels}
                  onChange={(e) => saveCascades({ ...cascades, showLabels: e.target.checked })}
                  data-testid="cascades-labels-toggle"
                />
                <span className="track" />
              </label>
            </div>
          </div>

          <div className="profile-field">
            <label>Толщина линий</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={1}
                max={3}
                step={1}
                value={cascades.lineWidth}
                onChange={(e) => saveCascades({ ...cascades, lineWidth: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.lineWidth}</span>
            </div>
          </div>

          <div className="profile-field">
            <label>Прозрачность линий, %</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={cascades.opacity}
                onChange={(e) => saveCascades({ ...cascades, opacity: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.opacity}%</span>
            </div>
            <div className="profile-scale-hint">Меньше — каскады не перекрывают свечи</div>
          </div>

          <button className="profile-action-btn" onClick={handleCascadesReset}>
            <Layers size={15} />
            сбросить каскады по умолчанию
          </button>
        </div>

        {/* Notifications section */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <Bell size={14} />
            </div>
            <h2>Уведомления</h2>
          </div>

          <div className="profile-field">
            <div className="profile-notify-row">
              <label>Звук при срабатывании</label>
              <label className="profile-switch">
                <input
                  type="checkbox"
                  checked={notifySound}
                  onChange={(e) => handleNotifySoundChange(e.target.checked)}
                  data-testid="notify-sound-toggle"
                />
                <span className="track" />
              </label>
            </div>
          </div>

          <div className="profile-field">
            <label>Громкость звука</label>
            <div className="profile-volume-row">
              <Volume2 size={13} className="shrink-0 text-[#888]" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={notifyVolume}
                disabled={!notifySound}
                onChange={(e) => handleNotifyVolumeChange(Number(e.target.value))}
                className="profile-volume-slider"
                data-testid="notify-volume-slider"
              />
              <span className="profile-volume-value">{Math.round(notifyVolume * 100)}%</span>
            </div>
          </div>

          <button
            className="profile-notify-test"
            disabled={!notifySound}
            onClick={() => playAlertSound(notifyVolume)}
          >
            <Volume2 size={13} />
            проверить звук
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
