import type { Alert } from '../types'
import { formatPrice, extractBaseAsset } from '../utils/format'

const ALERT_LABELS: Record<string, string> = {
  price: 'Price cross',
  impulse: 'Impulse',
  listing: 'Listing',
}

// ---------------------------------------------------------------------------
// Sound — synthesized WebAudio beep, no asset, no network. Browsers block
// audio until the first user gesture, so the context is created/resumed lazily
// from initAlertNotifications' gesture listeners.
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null
let lastBeepAt = 0
/** Min gap between beeps — a burst of alerts in one 5s tick must not machine-gun. */
const BEEP_MIN_GAP_MS = 700

/** How much of the alert to act on — sound can be muted, volume 0–1. */
export interface AlertNotifyOptions {
  sound?: boolean
  volume?: number
}

function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  const AC = w.AudioContext ?? w.webkitAudioContext
  if (!AC) return null
  if (!audioCtx) {
    try { audioCtx = new AC() } catch { return null }
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => { /* ignore */ })
  }
  return audioCtx
}

/** Short two-tone beep (880 → 660 Hz). Best-effort: silently no-ops anywhere audio is unavailable. */
export function playAlertSound(volume = 1): void {
  const now = Date.now()
  if (now - lastBeepAt < BEEP_MIN_GAP_MS) return
  lastBeepAt = now
  const ctx = getAudioCtx()
  if (!ctx || ctx.state !== 'running') return
  const peak = Math.max(0.0001, Math.min(1, volume)) * 0.22
  try {
    const t0 = ctx.currentTime
    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + dur + 0.05)
    }
    beep(880, t0, 0.18)
    beep(660, t0 + 0.22, 0.26)
  } catch { /* audio unavailable — sound is best-effort */ }
}

// ---------------------------------------------------------------------------
// Native browser notifications
// ---------------------------------------------------------------------------

let gesturesBound = false

/**
 * Browsers block autoplay AND the Notification permission prompt outside a
 * user gesture. Install one-time listeners so the first click/keystroke
 * unlocks the audio context and (only if the user hasn't decided yet) asks
 * for notification permission. Idempotent — safe to call from App mount.
 */
export function initAlertNotifications(): void {
  if (gesturesBound || typeof window === 'undefined') return
  gesturesBound = true
  const onGesture = () => {
    getAudioCtx()
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        const p = Notification.requestPermission()
        if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ })
      } catch { /* ignore */ }
    }
  }
  window.addEventListener('pointerdown', onGesture, { once: true })
  window.addEventListener('keydown', onGesture, { once: true })
}

/** Sound + native browser notification for a newly fired alert. */
export function notifyNewAlert(alert: Alert, opts: AlertNotifyOptions = {}): void {
  if (opts.sound !== false) playAlertSound(opts.volume ?? 1)
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const base = extractBaseAsset(alert.symbol) || 'ANY'
  const label = ALERT_LABELS[alert.type] ?? 'Alert'
  const priceText = alert.price != null ? ` — $${formatPrice(alert.price, 2)}` : ''
  const exchangeText = alert.exchange ? ` · ${alert.exchange}` : ''
  try {
    const n = new Notification(`${base}: ${label}`, {
      body: `${label}${priceText}${exchangeText}`,
      tag: `serotonin-alert-${alert.id}`,
    })
    n.onclick = () => {
      try { window.focus() } catch { /* ignore */ }
      n.close()
    }
  } catch { /* Notification unavailable — skip */ }
}
