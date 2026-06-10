import type { WsMessage } from '../types.js'

type WsCallback = (msg: WsMessage) => void

let ws: WebSocket | null = null
const wildcardCallbacks = new Set<WsCallback>()
const typeCallbacks = new Map<string, Set<WsCallback>>()
const channelCallbacks = new Map<string, Set<WsCallback>>()
const subscriptions = new Map<string, number>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let intentionalDisconnect = false
let reconnectAttempt = 0
const MAX_BACKOFF = 30000
const BASE_DELAY = 1000

// Liveness tracking: browsers throttle/suspend background tabs, which can
// silently break the socket (half-open) or delay timer-based reconnects for
// minutes. We track the last inbound message and force a fresh connection the
// moment the user returns (visibilitychange/online/pageshow/focus in App).
let lastMessageAt = 0
// If we haven't heard anything from the server in this window, treat the
// socket as dead even if readyState still reports OPEN. Server pings every
// 30s (see server hub), so 45s gives one full miss of slack.
const STALE_THRESHOLD = 45000

function dispatch(msg: WsMessage) {
  const t = msg.type as string | undefined
  if (t) {
    const set = typeCallbacks.get(t)
    if (set) for (const cb of set) cb(msg)
  }
  if (msg.channel) {
    const set = channelCallbacks.get(msg.channel)
    if (set) for (const cb of set) cb(msg)
  }
  if (wildcardCallbacks.size) {
    for (const cb of wildcardCallbacks) cb(msg)
  }
}

function connect() {
  intentionalDisconnect = false
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}/ws`
  ws = new WebSocket(url)

  ws.onopen = () => {
    reconnectAttempt = 0
    lastMessageAt = Date.now()
    dispatch({ type: 'open' })
    for (const ch of subscriptions.keys()) {
      ws?.send(JSON.stringify({ type: 'subscribe', channel: ch }))
    }
  }

  ws.onmessage = (e) => {
    lastMessageAt = Date.now()
    try {
      const msg = JSON.parse(e.data) as WsMessage
      dispatch(msg)
    } catch {}
  }

  ws.onclose = () => {
    if (!intentionalDisconnect) scheduleReconnect()
  }
  ws.onerror = () => ws?.close()
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempt) + Math.random() * 1000, MAX_BACKOFF)
  reconnectAttempt++
  console.warn(`[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

export function wsConnect() {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect()
}

/**
 * Force the socket back to a healthy state immediately. Call this when the
 * user returns to the tab (visibilitychange/focus/pageshow) or the network
 * comes back (online). Background tabs get throttled, so the normal
 * timer-based reconnect can lag by minutes — this bypasses that delay.
 */
export function ensureHealthyConnection() {
  if (intentionalDisconnect) return

  // Cancel any pending (throttled) reconnect and reset backoff so the retry
  // below is instant rather than waiting out an exponential delay.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0

  const state = ws?.readyState

  // No socket, or it's closing/closed → (re)connect now.
  if (!ws || state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
    connect()
    return
  }

  // Socket still connecting → let it finish.
  if (state === WebSocket.CONNECTING) return

  // OPEN but stale (half-open / suspended): no data for too long. Tear it down
  // and reconnect from scratch. onclose will be suppressed because we null the
  // handler, so we schedule the reconnect explicitly via connect().
  if (state === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_THRESHOLD) {
    const dead = ws
    ws = null
    dead.onclose = null
    dead.onerror = null
    try { dead.close() } catch { /* noop */ }
    connect()
  }
}

export function wsDisconnect() {
  intentionalDisconnect = true
  ws?.close()
  ws = null
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
}

export function wsSubscribe(channel: string) {
  const count = subscriptions.get(channel) || 0
  subscriptions.set(channel, count + 1)
  if (count > 0) return
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', channel }))
  }
}

export function wsUnsubscribe(channel: string) {
  const count = subscriptions.get(channel) || 0
  if (count === 0) return
  if (count > 1) {
    subscriptions.set(channel, count - 1)
    return
  }
  subscriptions.delete(channel)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'unsubscribe', channel }))
  }
}

export function wsOnMessage(cb: WsCallback): () => void {
  wildcardCallbacks.add(cb)
  return () => { wildcardCallbacks.delete(cb) }
}

export function wsOnType(type: string, cb: WsCallback): () => void {
  let set = typeCallbacks.get(type)
  if (!set) {
    set = new Set()
    typeCallbacks.set(type, set)
  }
  set.add(cb)
  return () => {
    const s = typeCallbacks.get(type)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) typeCallbacks.delete(type)
  }
}

export function wsOnChannel(channel: string, cb: WsCallback): () => void {
  let set = channelCallbacks.get(channel)
  if (!set) {
    set = new Set()
    channelCallbacks.set(channel, set)
  }
  set.add(cb)
  return () => {
    const s = channelCallbacks.get(channel)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) channelCallbacks.delete(channel)
  }
}
