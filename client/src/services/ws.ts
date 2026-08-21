import type { WsMessage } from '../types.js'
import { recordFrameLatency, recordMarketDataFreshness } from './latency.js'
import { recordDiag } from './candle-diag.js'

type WsCallback = (msg: WsMessage) => void

// --- DIAGNOSTICS ---
export interface WsDiagStats {
  framesReceived: number
  framesProcessed: number
  parseErrors: number
  queueErrors: number
  maxQueueLagMs: number
  reconnects: number
}

const wsDiag = {
  framesReceived: 0,
  framesProcessed: 0,
  parseErrors: 0,
  queueErrors: 0,
  maxQueueLagMs: 0,
  reconnects: 0,
}

export function getWsDiag(): WsDiagStats {
  return { ...wsDiag }
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __wsDiag: unknown }).__wsDiag = { inspect: getWsDiag }
}

let ws: WebSocket | null = null
const wildcardCallbacks = new Set<WsCallback>()
const typeCallbacks = new Map<string, Set<WsCallback>>()
const channelCallbacks = new Map<string, Set<WsCallback>>()
const subscriptions = new Map<string, number>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let intentionalDisconnect = false
let reconnectAttempt = 0
// Reconnect epoch: incremented on EVERY socket open (initial + reconnects).
// Charts use it to re-pull history after a reconnect, so periods that fell
// through the dead-window land back on the chart.
let wsOpenCount = 0
export function getWsOpenCount(): number {
  return wsOpenCount
}
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

/** Last inbound frame timestamp — global feed liveness signal for the UI. */
export function getWsLastMessageAt(): number {
  return lastMessageAt
}

// --- Deterministic self-heal watchdog ------------------------------------
// Event-driven recovery (onclose → scheduleReconnect, App's revive → 
// ensureHealthyConnection) has gaps: a half-open TCP death delivers no FIN,
// so onclose never fires; visibilitychange/focus are unreliable on Windows
// minimize/restore; a handshake stuck in CONNECTING was never retried. The
// watchdog polls every WATCHDOG_INTERVAL_MS and covers all three: dead/absent
// socket → connect, stuck CONNECTING → kill+retry, silent OPEN → teardown
// + reconnect. In hidden tabs the browser throttles setInterval to ~1/min,
// which still guarantees eventual recovery without any event at all.
const WATCHDOG_INTERVAL_MS = 15_000
const CONNECT_TIMEOUT_MS = 10_000
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let connectStartedAt = 0

function dispatch(msg: WsMessage) {
  const t = msg.type as string | undefined
  if (t) {
    const set = typeCallbacks.get(t)
    if (set) for (const cb of set) { try { cb(msg) } catch (e) { console.error('[WS] subscriber error', e) } }
  }
  if (msg.channel) {
    const set = channelCallbacks.get(msg.channel)
    if (set) for (const cb of set) { try { cb(msg) } catch (e) { console.error('[WS] subscriber error', e) } }
  }
  if (wildcardCallbacks.size) {
    for (const cb of wildcardCallbacks) { try { cb(msg) } catch (e) { console.error('[WS] subscriber error', e) } }
  }
}

export function isHighPriorityMessage(msg: Pick<WsMessage, 'type'>): boolean {
  const type = msg.type as string | undefined
  return !!type && (
    type.startsWith('trade:') ||
    type.startsWith('candle:') ||
    type.startsWith('price:')
  )
}

function processParsedMessage(msg: WsMessage, arrivedAt: number): void {
  wsDiag.framesProcessed++
  const lag = Date.now() - arrivedAt
  if (lag > wsDiag.maxQueueLagMs) wsDiag.maxQueueLagMs = lag
  if (lag > 500) {
    recordDiag('ws_frame_lag', { detail: `${lag}ms queue lag, stale=${lag / 1000}s` })
  }
  if (typeof msg.ts === 'number') {
    recordFrameLatency(Date.now() - msg.ts)
  }
  const eventTimeMs = (msg.data as { eventTimeMs?: unknown } | undefined)?.eventTimeMs
  if (typeof eventTimeMs === 'number') {
    recordMarketDataFreshness(Date.now() - eventTimeMs)
  }
  dispatch(msg)
}

// Server frames are deflate-raw compressed binary (see server hub.ts
// encodePayload). DecompressionStream is async, so frames are processed
// through a promise chain to preserve WebSocket message order.
async function decompressFrame(buf: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([buf]).stream().pipeThrough(ds)
  return await new Response(stream).text()
}

function connect() {
  intentionalDisconnect = false
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}/ws`
  // Capture the socket in a closure local: a late event from an OLD socket
  // (error/close racing a reconnect) must never act on the NEW one through
  // the module-level `ws` reference.
  const socket = new WebSocket(url)
  ws = socket
  connectStartedAt = Date.now()
  socket.binaryType = 'arraybuffer'

  socket.onopen = () => {
    reconnectAttempt = 0
    connectStartedAt = 0
    wsOpenCount++
    lastMessageAt = Date.now()
    dispatch({ type: 'open' })
    for (const ch of subscriptions.keys()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'subscribe', channel: ch }))
      }
    }
  }

  let frameQueue: Promise<void> = Promise.resolve()
  socket.onmessage = (e) => {
    lastMessageAt = Date.now()
    wsDiag.framesReceived++
    const arrivedAt = Date.now()

    // Hot chart lanes are deliberately emitted by the server as small text
    // frames. Parse and dispatch them immediately so a large compressed
    // ticker/density snapshot cannot hold executed trades behind async
    // DecompressionStream work. Low-priority frames retain their serial order.
    if (typeof e.data === 'string') {
      try {
        const parsed = JSON.parse(e.data) as WsMessage
        if (isHighPriorityMessage(parsed)) {
          processParsedMessage(parsed, arrivedAt)
          return
        }
        frameQueue = frameQueue
          .then(() => processParsedMessage(parsed, arrivedAt))
          .catch((err) => {
            wsDiag.queueErrors++
            console.error('[WS] frame-queue rejection, chain reseeded', err)
            recordDiag('ws_frame_queue_error', { detail: err instanceof Error ? err.message : String(err) })
          })
        return
      } catch {
        wsDiag.parseErrors++
        return
      }
    }

    frameQueue = frameQueue
      .then(async () => {
        try {
          const text = await decompressFrame(e.data)
          const msg = JSON.parse(text) as WsMessage
          processParsedMessage(msg, arrivedAt)
        } catch { wsDiag.parseErrors++ /* ignore malformed frame */ }
      })
      .catch((err) => {
        // A rejected frame must NEVER blackhole the whole chain: without a
        // failure handler every subsequent frame would silently vanish while
        // this promise stays rejected. Log it and let the chain continue.
        wsDiag.queueErrors++
        console.error('[WS] frame-queue rejection, chain reseeded', err)
        recordDiag('ws_frame_queue_error', { detail: err instanceof Error ? err.message : String(err) })
      })
  }

  socket.onclose = () => {
    if (ws === socket) ws = null
    if (!intentionalDisconnect) scheduleReconnect()
  }
  socket.onerror = () => {
    // Close THIS socket, never the module-level one: by the time a stale
    // socket's error fires, `ws` may already point at a newer healthy socket
    // (closing that one would kill a live connection needlessly).
    try { socket.close() } catch { /* noop */ }
  }

  // The watchdog drives every recovery path deterministically — it must
  // exist from the very first connect.
  ensureWatchdog()
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempt) + Math.random() * 1000, MAX_BACKOFF)
  reconnectAttempt++
  wsDiag.reconnects++
  console.warn(`[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`)
  recordDiag('ws_reconnect', { detail: `attempt ${reconnectAttempt} in ${Math.round(delay)}ms` })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

export function wsConnect() {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect()
}

/**
 * Deterministic self-heal loop (started by the first connect()). The
 * event-driven paths (onclose → scheduleReconnect, App's revive →
 * ensureHealthyConnection) are not enough:
 *  - a half-open TCP death delivers no FIN → onclose never fires;
 *  - visibilitychange/focus are unreliable on Windows minimize/restore;
 *  - a handshake stuck in CONNECTING was never retried (no timeout anywhere).
 * The watchdog closes all three gaps on a fixed cadence. In hidden tabs the
 * browser throttles setInterval to ~1/min — slow but still guaranteed, with
 * no dependency on any browser event.
 */
function ensureWatchdog() {
  if (watchdogTimer !== null) return
  watchdogTimer = setInterval(() => {
    if (intentionalDisconnect) return
    const socket = ws

    // No socket / dying → connect now (unless a reconnect is already queued).
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      if (!reconnectTimer) connect()
      return
    }

    // Stuck handshake: a CONNECTING socket that never settles blocks recovery
    // forever (in some network states neither open nor error fires). Kill it
    // and schedule the next attempt explicitly — its onclose is suppressed to
    // avoid double-scheduling.
    if (socket.readyState === WebSocket.CONNECTING) {
      if (Date.now() - connectStartedAt > CONNECT_TIMEOUT_MS) {
        if (ws === socket) ws = null
        socket.onclose = null
        socket.onerror = null
        try { socket.close() } catch { /* noop */ }
        scheduleReconnect()
      }
      return
    }

    // OPEN but silent: half-open TCP (no FIN ever arrives → no onclose → no
    // scheduled reconnect). Tear down and reconnect from scratch.
    if (Date.now() - lastMessageAt > STALE_THRESHOLD) {
      if (ws === socket) ws = null
      socket.onclose = null
      socket.onerror = null
      try { socket.close() } catch { /* noop */ }
      connect()
    }
  }, WATCHDOG_INTERVAL_MS)
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

  const socket = ws

  // No socket, or it's closing/closed → (re)connect now.
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    connect()
    return
  }

  // Still connecting → let it finish, UNLESS the handshake is stuck: a
  // CONNECTING socket older than CONNECT_TIMEOUT_MS is killed and retried
  // (previously this branch returned unconditionally, and a hung handshake
  // left the app dead until a manual reload).
  if (socket.readyState === WebSocket.CONNECTING) {
    if (Date.now() - connectStartedAt > CONNECT_TIMEOUT_MS) {
      if (ws === socket) ws = null
      socket.onclose = null
      socket.onerror = null
      try { socket.close() } catch { /* noop */ }
      connect()
    }
    return
  }

  // OPEN but stale (half-open / suspended): no data for too long. Tear it down
  // and reconnect from scratch. onclose will be suppressed because we null the
  // handler, so we schedule the reconnect explicitly via connect().
  if (Date.now() - lastMessageAt > STALE_THRESHOLD) {
    if (ws === socket) ws = null
    socket.onclose = null
    socket.onerror = null
    try { socket.close() } catch { /* noop */ }
    connect()
  }
}

export function wsDisconnect() {
  intentionalDisconnect = true
  const socket = ws
  ws = null
  if (socket) {
    socket.onclose = null
    socket.onerror = null
    try { socket.close() } catch { /* noop */ }
  }
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
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
