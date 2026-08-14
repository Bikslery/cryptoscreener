import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAuthStore, useUIStore } from '../../store'
import { useDrawingHotkeysStore, eventToCombo, formatCombo, DRAWING_TOOL_LABELS, DEFAULT_DRAWING_HOTKEYS, type HotkeyTool } from '../../store/drawingHotkeys'
import api from '../../services/api'
import { playAlertSound } from '../../services/alert-notify'
import { X, User, LogOut, Shield, KeyRound, Keyboard, BarChart3, Bell, Volume2, Layers, Table2, ChevronUp, ChevronDown } from 'lucide-react'
import { resolveCascadesConfig } from '../../services/chart-overlays'
import { resolveIndicators, INDICATOR_LABELS, VALID_INDICATOR_KEYS } from '../../services/indicators'
import { useAlertStore } from '../../store'
import type { CascadesConfig, IndicatorKey, CoinListColKey, Exchange, Alert as AlertType } from '../../types'
import './ProfileModal.css'

type ResetStep = 'idle' | 'code' | 'password' | 'done'

/**
 * Collapsible cabinet section: the header is a full-width button; the body
 * animates open/closed via a grid-rows transition (dynamic content height,
 * no magic max-height). Content stays mounted, so form state survives
 * collapsing. Every section is independent (plain toggle) and starts closed.
 */
function ProfileSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`profile-section ${open ? 'open' : 'collapsed'}`}>
      <button type="button" className="section-header" onClick={() => setOpen(o => !o)}>
        <div className="section-icon">{icon}</div>
        <h2>{title}</h2>
        <ChevronDown size={14} className="section-chevron" />
      </button>
      <div className="section-body">
        <div className="section-body-inner">{children}</div>
      </div>
    </div>
  )
}

const EXCHANGE_LABELS: Record<Exchange, string> = {
  'binance-futures': 'Binance Futures',
  'binance-spot': 'Binance Spot',
  'bybit-futures': 'Bybit Futures',
  'okx-spot': 'OKX Spot',
  'okx-futures': 'OKX Futures',
}

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
  const [recording, setRecording] = useState<HotkeyTool | null>(null)
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

  // Fired-alert toast: corner position + auto-close duration (seconds).
  const [toastPosition, setToastPosition] = useState<'bottom-right' | 'bottom-left'>(settings?.notifyToastPosition ?? 'bottom-right')
  const [toastDuration, setToastDuration] = useState(settings?.notifyToastDurationSec ?? 20)
  const toastSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setToastPosition(settings?.notifyToastPosition ?? 'bottom-right')
  }, [settings?.notifyToastPosition])

  useEffect(() => {
    setToastDuration(settings?.notifyToastDurationSec ?? 20)
  }, [settings?.notifyToastDurationSec])

  const handleToastPositionChange = (p: 'bottom-right' | 'bottom-left') => {
    setToastPosition(p)
    if (toastSaveTimer.current) clearTimeout(toastSaveTimer.current)
    toastSaveTimer.current = setTimeout(() => {
      updateSettings({ notifyToastPosition: p }).catch(() => {})
    }, 400)
  }

  const handleToastDurationChange = (sec: number) => {
    setToastDuration(sec)
    if (toastSaveTimer.current) clearTimeout(toastSaveTimer.current)
    toastSaveTimer.current = setTimeout(() => {
      updateSettings({ notifyToastDurationSec: sec }).catch(() => {})
    }, 400)
  }

  useEffect(() => {
    return () => {
      if (toastSaveTimer.current) clearTimeout(toastSaveTimer.current)
    }
  }, [])

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

  useEffect(() => {
    return () => {
      if (indicatorsSaveTimer.current) clearTimeout(indicatorsSaveTimer.current)
    }
  }, [])

  const handleCascadesReset = () => {
    setCascades(resolveCascadesConfig(undefined))
    if (cascadesSaveTimer.current) clearTimeout(cascadesSaveTimer.current)
    updateSettings({ cascades: undefined }).catch(() => {})
  }

  // Indicator column configuration — coin list columns + mini-chart header
  // fields. Ordered lists with up/down arrows, add/remove chips below.
  const [indicators, setIndicators] = useState<{ coinList: CoinListColKey[]; chartHeader: IndicatorKey[] }>(() =>
    resolveIndicators(settings?.indicators),
  )
  const indicatorsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setIndicators(resolveIndicators(settings?.indicators))
  }, [settings?.indicators])

  const saveIndicators = (next: { coinList: CoinListColKey[]; chartHeader: IndicatorKey[] }) => {
    setIndicators(next)
    if (indicatorsSaveTimer.current) clearTimeout(indicatorsSaveTimer.current)
    indicatorsSaveTimer.current = setTimeout(() => {
      updateSettings({ indicators: next }).catch(() => {})
    }, 400)
  }

  const saveIndicatorField = (field: 'coinList' | 'chartHeader', list: CoinListColKey[] | IndicatorKey[]) => {
    if (field === 'coinList') saveIndicators({ ...indicators, coinList: list as CoinListColKey[] })
    else saveIndicators({ ...indicators, chartHeader: list as IndicatorKey[] })
  }

  const moveIndicatorsItem = (field: 'coinList' | 'chartHeader', index: number, dir: -1 | 1) => {
    const list = indicators[field]
    const target = index + dir
    if (target < 0 || target >= list.length) return
    // `symbol` is pinned at position 0 in the coin list.
    if (field === 'coinList' && (list[index] === 'symbol' || list[target] === 'symbol')) return
    const next = [...list]
    ;[next[index], next[target]] = [next[target], next[index]]
    saveIndicatorField(field, next)
  }

  const removeIndicator = (field: 'coinList' | 'chartHeader', key: IndicatorKey) => {
    const list = indicators[field]
    if (field === 'chartHeader' && list.length <= 1) return
    saveIndicatorField(field, list.filter(k => k !== key))
  }

  const addIndicator = (field: 'coinList' | 'chartHeader', key: IndicatorKey) => {
    if (indicators[field].includes(key)) return
    saveIndicatorField(field, [...indicators[field], key])
  }

  const handleIndicatorsReset = () => {
    setIndicators(resolveIndicators(undefined))
    if (indicatorsSaveTimer.current) clearTimeout(indicatorsSaveTimer.current)
    updateSettings({ indicators: undefined }).catch(() => {})
  }

  // --- Impulse alert master toggle (one ANY-alert per user) ---

  const EXCHANGE_OPTIONS: { value: Exchange | 'all'; label: string }[] = [
    { value: 'all', label: 'Все биржи' },
    ...(Object.keys(EXCHANGE_LABELS) as Exchange[]).map((ex) => ({ value: ex, label: EXCHANGE_LABELS[ex] })),
  ]

  const [alertPercent, setAlertPercent] = useState(3)
  const [alertExchange, setAlertExchange] = useState<Exchange | 'all'>('all')
  const [alertTelegram, setAlertTelegram] = useState(false)
  const [alertsEnabled, setAlertsEnabled] = useState(false)
  const [alertSaving, setAlertSaving] = useState(false)
  const [alertError, setAlertError] = useState('')
  const [managedAlertId, setManagedAlertId] = useState<string | null>(null)
  const alertSettingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [exchangeMenuOpen, setExchangeMenuOpen] = useState(false)
  const [exchangeMenuPos, setExchangeMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const exchangeBtnRef = useRef<HTMLButtonElement | null>(null)

  /** Condition built from EXPLICIT values — never from a stale render closure. */
  const buildImpulseCondition = (next: { percent: number; exchange: Exchange | 'all'; telegram: boolean }) => ({
    percent: next.percent,
    timeframe: '5m',
    direction: 'both',
    volumeSpike: 0,
    telegram: next.telegram,
    exchanges: next.exchange === 'all'
      ? (Object.keys(EXCHANGE_LABELS) as Exchange[]).map((exchange) => ({ exchange, minVolume24h: 0 }))
      : [{ exchange: next.exchange, minVolume24h: 0 }],
  })

  // The gate mounts this modal fresh on every open — load the user's ANY
  // impulse alert (latest) and mirror its state into the form.
  useEffect(() => {
    let cancelled = false
    api.get('/alerts')
      .then((res) => {
        if (cancelled) return
        const list = res.data as AlertType[]
        const impulse = list
          .filter(a => a.type === 'impulse' && a.symbol === 'ANY')
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
        setManagedAlertId(impulse?.id ?? null)
        setAlertsEnabled(impulse?.active === true)
        if (impulse?.condition) {
          const cond = impulse.condition as { percent?: number; exchanges?: { exchange: Exchange }[]; telegram?: boolean }
          if (typeof cond.percent === 'number') setAlertPercent(Math.min(50, Math.max(0.1, cond.percent)))
          if (Array.isArray(cond.exchanges)) {
            if (cond.exchanges.length === 1) setAlertExchange(cond.exchanges[0].exchange)
            else setAlertExchange('all')
          }
          setAlertTelegram(cond.telegram === true)
        }
      })
      .catch(() => { /* keep defaults */ })
    return () => { cancelled = true }
  }, [])

  const handleAlertsToggle = async (on: boolean) => {
    setAlertError('')
    if (on && (!isFinite(alertPercent) || alertPercent <= 0)) {
      setAlertError('Укажите % движения')
      return
    }
    setAlertSaving(true)
    try {
      if (on) {
        const condition = buildImpulseCondition({ percent: alertPercent, exchange: alertExchange, telegram: alertTelegram })
        if (managedAlertId) {
          const res = await api.patch(`/alerts/${managedAlertId}`, { active: true, condition })
          useAlertStore.getState().updateAlert(res.data as AlertType)
        } else {
          const res = await api.post('/alerts', { type: 'impulse', symbol: 'ANY', condition })
          setManagedAlertId(res.data.id)
          useAlertStore.getState().addCreated(res.data as AlertType)
        }
        setAlertsEnabled(true)
      } else {
        if (managedAlertId) {
          const res = await api.patch(`/alerts/${managedAlertId}`, { active: false })
          useAlertStore.getState().updateAlert(res.data as AlertType)
        }
        setAlertsEnabled(false)
      }
    } catch (err: any) {
      setAlertError(err.response?.data?.error || 'Не удалось изменить состояние алертов')
    } finally {
      setAlertSaving(false)
    }
  }

  // Settings apply to the enabled alert automatically (debounced PATCH).
  // Values are passed in explicitly — the timer closure must never read
  // stale state from the render that scheduled it.
  const queueAlertSettingsSave = (next: { percent: number; exchange: Exchange | 'all'; telegram: boolean }) => {
    if (!alertsEnabled || !managedAlertId) return
    if (alertSettingsTimer.current) clearTimeout(alertSettingsTimer.current)
    alertSettingsTimer.current = setTimeout(async () => {
      if (!isFinite(next.percent) || next.percent <= 0) return
      try {
        const res = await api.patch(`/alerts/${managedAlertId}`, { condition: buildImpulseCondition(next) })
        useAlertStore.getState().updateAlert(res.data as AlertType)
      } catch { /* keep local state */ }
    }, 400)
  }

  const toggleExchangeMenu = () => {
    if (exchangeMenuOpen) {
      setExchangeMenuOpen(false)
      return
    }
    const el = exchangeBtnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setExchangeMenuPos({ top: r.bottom + 6, left: r.left, width: r.width })
    setExchangeMenuOpen(true)
  }

  useEffect(() => {
    if (!exchangeMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (exchangeBtnRef.current?.contains(e.target as Node)) return
      setExchangeMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExchangeMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [exchangeMenuOpen])

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

  const handleHotkeyDown = (tool: HotkeyTool, e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    setHotkeyError('')
    if (e.key === 'Escape') {
      setBinding(tool, '').catch(() => setHotkeyError('Не удалось сохранить'))
      setRecording(null)
      return
    }
    const combo = eventToCombo(e.nativeEvent)
    if (!combo) return

    const otherTool = (Object.keys(bindings) as HotkeyTool[]).find(
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
        <ProfileSection icon={<User size={14} />} title="Аккаунт">

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
        </ProfileSection>

        {/* Actions section */}
        <ProfileSection icon={<Shield size={14} />} title="Действия">

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
        </ProfileSection>

        {/* Chart settings section */}
        <ProfileSection icon={<BarChart3 size={14} />} title="График">

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
        </ProfileSection>

        {/* Cascades section — full engine configuration */}
        <ProfileSection icon={<Layers size={14} />} title="Каскады">

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
            <label>Мин. касаний уровня</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={cascades.minTouches}
                onChange={(e) => saveCascades({ ...cascades, minTouches: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.minTouches || 'без'}</span>
            </div>
            <div className="profile-scale-hint">Каскад рисуется, только если его уровень касались минимум N раз (0 — хотя бы одно касание)</div>
          </div>

          <div className="profile-field">
            <label>Дистанция касания, %</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0.05}
                max={0.5}
                step={0.05}
                value={cascades.touchDistancePct}
                onChange={(e) => saveCascades({ ...cascades, touchDistancePct: Number(e.target.value) })}
                className="profile-scale-slider"
              />
              <span className="profile-scale-value">{cascades.touchDistancePct}%</span>
            </div>
            <div className="profile-scale-hint">Насколько близко должна пройти свеча, чтобы это считалось касанием</div>
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
        </ProfileSection>

        {/* Indicators section — coin list columns + chart header fields */}
        <ProfileSection icon={<Table2 size={14} />} title="Индикаторы">

          <div className="profile-field">
            <label>Колонки списка монет</label>
            {indicators.coinList.map((key, i) => (
              <div key={key} className="indicator-order-row">
                <span className={`indicator-order-label ${key === 'symbol' ? 'pinned' : ''}`}>
                  {key === 'symbol' ? 'Тикер (закреплён)' : INDICATOR_LABELS[key as IndicatorKey]}
                </span>
                {key !== 'symbol' && (
                  <div className="indicator-order-actions">
                    <button
                      className="indicator-order-btn"
                      disabled={i <= 1}
                      title="Выше"
                      onClick={() => moveIndicatorsItem('coinList', i, -1)}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      className="indicator-order-btn"
                      disabled={i >= indicators.coinList.length - 1}
                      title="Ниже"
                      onClick={() => moveIndicatorsItem('coinList', i, 1)}
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      className="indicator-order-btn danger"
                      title="Убрать колонку"
                      onClick={() => removeIndicator('coinList', key as IndicatorKey)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="indicator-add-row">
              {VALID_INDICATOR_KEYS.filter(k => !indicators.coinList.includes(k)).map(k => (
                <button key={k} className="indicator-add-chip" onClick={() => addIndicator('coinList', k)}>
                  + {INDICATOR_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          <div className="profile-field">
            <label>Поля шапки графиков</label>
            {indicators.chartHeader.map((key, i) => (
              <div key={key} className="indicator-order-row">
                <span className="indicator-order-label">{INDICATOR_LABELS[key]}</span>
                <div className="indicator-order-actions">
                  <button
                    className="indicator-order-btn"
                    disabled={i === 0}
                    title="Выше"
                    onClick={() => moveIndicatorsItem('chartHeader', i, -1)}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    className="indicator-order-btn"
                    disabled={i >= indicators.chartHeader.length - 1}
                    title="Ниже"
                    onClick={() => moveIndicatorsItem('chartHeader', i, 1)}
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    className="indicator-order-btn danger"
                    disabled={indicators.chartHeader.length <= 1}
                    title="Убрать поле"
                    onClick={() => removeIndicator('chartHeader', key)}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
            <div className="indicator-add-row">
              {VALID_INDICATOR_KEYS.filter(k => !indicators.chartHeader.includes(k)).map(k => (
                <button key={k} className="indicator-add-chip" onClick={() => addIndicator('chartHeader', k)}>
                  + {INDICATOR_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          <button className="profile-action-btn" onClick={handleIndicatorsReset}>
            <Table2 size={15} />
            сбросить индикаторы
          </button>
        </ProfileSection>

        {/* Alerts section — master toggle + impulse settings */}
        <ProfileSection icon={<Bell size={14} />} title="Алерты">

          <div className="alert-master-row">
            <div className="alert-master-info">
              <div className="alert-master-title">Включить алерты</div>
              <div className="profile-scale-hint">
                Импульс-алерт: движение (high−low)/low свечи ≥ порога
              </div>
            </div>
            <label className="alert-master-switch">
              <input
                type="checkbox"
                checked={alertsEnabled}
                disabled={alertSaving}
                onChange={(e) => handleAlertsToggle(e.target.checked)}
                data-testid="alerts-master-toggle"
              />
              <span className="track" />
            </label>
          </div>

          <div className="profile-field">
            <label>Импульс — % движения свечи</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={0.1}
                max={50}
                step={0.1}
                value={alertPercent}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setAlertPercent(v)
                  queueAlertSettingsSave({ percent: v, exchange: alertExchange, telegram: alertTelegram })
                }}
                className="profile-scale-slider alert-scale-slider"
                data-testid="alert-percent-slider"
              />
              <span className="profile-scale-value">{alertPercent}%</span>
            </div>
            <div className="profile-scale-hint">
              (high−low)/low свечи ≥ порога — алерт сработает, как только движение превысит его
            </div>
          </div>

          <div className="profile-field">
            <label>Биржа, с которой приходит алерт</label>
            <div className="alert-exchange-wrap">
              <button
                ref={exchangeBtnRef}
                type="button"
                className="alert-exchange-btn"
                onClick={toggleExchangeMenu}
                data-testid="alert-exchange-select"
              >
                <span>{alertExchange === 'all' ? 'Все биржи' : EXCHANGE_LABELS[alertExchange]}</span>
                <ChevronDown size={14} className={`alert-exchange-chevron ${exchangeMenuOpen ? 'open' : ''}`} />
              </button>
              {exchangeMenuOpen && exchangeMenuPos && (
                <div
                  className="alert-exchange-menu"
                  style={{ top: exchangeMenuPos.top, left: exchangeMenuPos.left, width: exchangeMenuPos.width }}
                >
                  {EXCHANGE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`alert-exchange-option ${alertExchange === opt.value ? 'selected' : ''}`}
                      onClick={() => {
                        setAlertExchange(opt.value)
                        setExchangeMenuOpen(false)
                        queueAlertSettingsSave({ percent: alertPercent, exchange: opt.value, telegram: alertTelegram })
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="profile-scale-hint">
              Все биржи — проверка по всем рынкам; конкретная — только с неё
            </div>
          </div>

          <div className="profile-field">
            <div className="profile-notify-row">
              <label>Уведомлять в Telegram</label>
              <label className="profile-switch">
                <input
                  type="checkbox"
                  checked={alertTelegram}
                  onChange={(e) => {
                    setAlertTelegram(e.target.checked)
                    queueAlertSettingsSave({ percent: alertPercent, exchange: alertExchange, telegram: e.target.checked })
                  }}
                  data-testid="alert-telegram-toggle"
                />
                <span className="track" />
              </label>
            </div>
            <div className="profile-scale-hint">
              Выключено по умолчанию — уведомления приходят только в браузере
            </div>
          </div>

          {alertError && <div className="profile-reset-error">{alertError}</div>}
        </ProfileSection>

        {/* Notifications section */}
        <ProfileSection icon={<Bell size={14} />} title="Уведомления">

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

          <div className="profile-field">
            <label>Позиция всплывающего окна</label>
            <select
              className="profile-alert-select"
              style={{ width: '100%' }}
              value={toastPosition}
              onChange={(e) => handleToastPositionChange(e.target.value as 'bottom-right' | 'bottom-left')}
              data-testid="toast-position-select"
            >
              <option value="bottom-right">справа снизу</option>
              <option value="bottom-left">слева снизу</option>
            </select>
          </div>

          <div className="profile-field">
            <label>Автозакрытие окна, сек</label>
            <div className="profile-scale-row">
              <input
                type="range"
                min={5}
                max={120}
                step={5}
                value={toastDuration}
                onChange={(e) => handleToastDurationChange(Number(e.target.value))}
                className="profile-scale-slider"
                data-testid="toast-duration-slider"
              />
              <span className="profile-scale-value">{toastDuration}с</span>
            </div>
            <div className="profile-scale-hint">
              Окна складываются друг над другом; Ctrl+клик по крестику закрывает все
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
        </ProfileSection>

        {/* Hotkeys section */}
        <ProfileSection icon={<Keyboard size={14} />} title="Горячие клавиши рисования">

          {hotkeyError && <div className="profile-reset-error">{hotkeyError}</div>}

          {(Object.keys(DEFAULT_DRAWING_HOTKEYS) as HotkeyTool[]).map((tool) => (
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
        </ProfileSection>
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
