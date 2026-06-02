import type { WsMessage } from '../types.js'

type WsCallback = (msg: WsMessage) => void

let ws: WebSocket | null = null
const wildcardCallbacks = new Set<WsCallback>()
const typeCallbacks = new Map<string, Set<WsCallback>>()
const channelCallbacks = new Map<string, Set<WsCallback>>()
const subscriptions = new Map<string, number>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let intentionalDisconnect = false

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
    dispatch({ type: 'open' })
    for (const ch of subscriptions.keys()) {
      ws?.send(JSON.stringify({ type: 'subscribe', channel: ch }))
    }
  }

  ws.onmessage = (e) => {
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 3000)
}

export function wsConnect() {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect()
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
