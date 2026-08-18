import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '../../store'
import api from '../../services/api'
import CursorGlow from '../effects/CursorGlow'
import Particles from '../effects/Particles'
import './AuthModal.css'

/**
 * Mandatory Telegram-binding gate. Rendered when the user is logged in but
 * their Telegram is not bound (fresh registration, or a page reload in the
 * middle of the bind flow — component state would otherwise be lost and the
 * user would land on the charts unverified). There is no way out except
 * binding Telegram or logging out.
 */
export default function TelegramGate() {
  const checkSession = useAuthStore(s => s.checkSession)
  const logout = useAuthStore(s => s.logout)
  const [telegramLink, setTelegramLink] = useState('')
  const [bindError, setBindError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const POLL_MAX_ATTEMPTS = 100 // 5 minutes at 3s intervals

  const startPolling = () => {
    stopPolling()
    setBindError('')
    let attempts = 0
    pollRef.current = setInterval(async () => {
      attempts++
      if (attempts > POLL_MAX_ATTEMPTS) {
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
          await checkSession()
        }
      } catch {
        // ignore network errors, keep polling
      }
    }, 3000)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.get('/auth/telegram-status')
        if (cancelled) return
        setTelegramLink(res.data.telegramLink)
        if (res.data.telegramVerified) {
          await checkSession()
          return
        }
        startPolling()
      } catch {
        if (!cancelled) setError('Failed to get the binding link. Refresh the page.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="auth-page">
      <Particles style="white" />
      <CursorGlow />

      <div className="auth-card">
        <div className="auth-step-enter">
          <div className="auth-heading">Link Telegram</div>
          <p className="auth-telegram-text">
            To access the service you must link your Telegram account
          </p>
          <p className="auth-telegram-hint">
            Click the button below, open the bot and send <code>/start</code>
          </p>

          {loading ? (
            <p className="auth-polling-text">Loading...</p>
          ) : (
            <>
              <a
                href={telegramLink}
                target="_blank"
                rel="noopener noreferrer"
                className="auth-telegram-link"
              >
                Open Telegram
              </a>
              {!bindError && !error && (
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
            </>
          )}

          <button
            onClick={() => logout()}
            className="auth-back"
            style={{ marginTop: '1.5rem' }}
          >
            log out
          </button>
        </div>
      </div>
    </div>
  )
}
