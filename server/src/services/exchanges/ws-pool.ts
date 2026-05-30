import WebSocket from 'ws'
import type { Agent } from 'http'

const MAX_STREAMS_PER_CONN = 200

interface PoolConn {
  ws: WebSocket | null
  streams: Set<string>
  generation: number
}

/**
 * WsStreamPool manages one or more WebSocket connections to a Binance
 * combined-stream endpoint (`/stream?streams=...`).
 *
 * When `supportsIncrementalSub` is true (default for Binance), adding or
 * removing a stream sends SUBSCRIBE / UNSUBSCRIBE on the live connection
 * instead of tearing it down and reconnecting — eliminating data gaps.
 *
 * When the flag is false (or for adapters that don't support it), the old
 * scheduleReconnect behaviour is used as a fallback.
 */
export class WsStreamPool {
  private baseUrl: string
  private name: string
  private onMessage: (msg: any) => void
  private agent: Agent | undefined
  private connections: PoolConn[] = []
  private intentionalClose = false
  private supportsIncrementalSub: boolean

  constructor(
    baseUrl: string,
    name: string,
    onMessage: (msg: any) => void,
    agent?: Agent,
    supportsIncrementalSub = true,
  ) {
    this.baseUrl = baseUrl
    this.name = name
    this.onMessage = onMessage
    this.agent = agent
    this.supportsIncrementalSub = supportsIncrementalSub
  }

  // ── Public API ─────────────────────────────────────────────

  addStream(stream: string) {
    let target = this.connections.find(c => c.streams.size < MAX_STREAMS_PER_CONN)
    if (!target) {
      target = { ws: null, streams: new Set(), generation: 0 }
      this.connections.push(target)
    }

    const isNew = !target.streams.has(stream)
    target.streams.add(stream)
    if (!isNew) return

    if (this.supportsIncrementalSub && target.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(target, [stream])
    } else if (!target.ws || target.ws.readyState === WebSocket.CLOSED) {
      this.scheduleReconnect()
    }
  }

  removeStream(stream: string) {
    for (const conn of this.connections) {
      if (!conn.streams.delete(stream)) continue

      // Stream was removed from this conn — send UNSUBSCRIBE if live
      if (this.supportsIncrementalSub && conn.ws?.readyState === WebSocket.OPEN) {
        this.sendUnsubscribe(conn, [stream])
      }

      // Close empty connections
      if (conn.streams.size === 0 && conn.ws) {
        conn.generation++
        try { conn.ws.close() } catch {}
        conn.ws = null
      } else if (!this.supportsIncrementalSub && conn.ws) {
        // Non-incremental: need full reconnect to update stream set
        this.scheduleReconnect()
        return
      }
    }
    this.connections = this.connections.filter(c => c.streams.size > 0)

    // Fallback: if incremental not supported, rebuild remaining conns
    if (!this.supportsIncrementalSub) {
      this.scheduleReconnect()
    }
  }

  get size(): number {
    return this.connections.reduce((sum, c) => sum + c.streams.size, 0)
  }

  close() {
    this.intentionalClose = true
    for (const conn of this.connections) {
      if (conn.ws) {
        conn.generation++
        try { conn.ws.close() } catch {}
        conn.ws = null
      }
    }
    this.connections = []
  }

  // ── Incremental SUBSCRIBE / UNSUBSCRIBE ────────────────────

  private sendSubscribe(conn: PoolConn, streams: string[]) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return
    const msg = JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: this.nextReqId() })
    conn.ws.send(msg)
    console.log(`[${this.name}] SUBSCRIBE ${streams.length} stream(s) on live WS (total: ${conn.streams.size})`)
  }

  private sendUnsubscribe(conn: PoolConn, streams: string[]) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return
    const msg = JSON.stringify({ method: 'UNSUBSCRIBE', params: streams, id: this.nextReqId() })
    conn.ws.send(msg)
    console.log(`[${this.name}] UNSUBSCRIBE ${streams.length} stream(s) on live WS (total: ${conn.streams.size})`)
  }

  private _reqId = 0
  private nextReqId(): number { return ++this._reqId }

  // ── Connection lifecycle ────────────────────────────────────

  private wsOpts(): WebSocket.ClientOptions | undefined {
    return this.agent ? { agent: this.agent } : undefined
  }

  /** Debounced full reconnect — used as fallback when incremental not supported,
   *  or when we need the initial connect. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private sendWsMessage(ws: WebSocket, msg: object) {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(msg))
    } catch (e) {
      console.error(`[${this.name}] Failed to send WS message:`, e instanceof Error ? e.message : e)
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doReconnect()
    }, 300)
  }

  private doReconnect() {
    if (this.intentionalClose) return

    for (const conn of this.connections) {
      if (conn.streams.size === 0) continue
      if (conn.ws?.readyState === WebSocket.OPEN) continue
      if (conn.ws) {
        conn.generation++
        try { conn.ws.close() } catch {}
        conn.ws = null
      }
      this.connectSingle(conn)
    }
  }

  /** Open (or reopen) a single conn, subscribing to all its streams
   *  via the `?streams=` URL param on initial connect. */
  private connectSingle(conn: PoolConn) {
    if (conn.streams.size === 0 || conn.ws?.readyState === WebSocket.OPEN) return

    const streams = Array.from(conn.streams).join('/')
    const url = `${this.baseUrl}?streams=${streams}`
    const generation = ++conn.generation
    console.log(`[${this.name}] WS connecting: ${conn.streams.size} streams`)

    conn.ws = new WebSocket(url, this.wsOpts())

    conn.ws.on('open', () => {
      console.log(`[${this.name}] WS connected (${conn.streams.size} streams)`)
    })

    conn.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        // Binance may send subscription-confirmation responses —
        // pass them through; the consumer can ignore if needed.
        this.onMessage(msg)
      } catch {}
    })

    conn.ws.on('error', (err) => {
      console.error(`[${this.name}] WS error:`, err.message || err)
    })

    conn.ws.on('close', () => {
      if (this.intentionalClose || generation !== conn.generation) return
      console.log(`[${this.name}] WS closed unexpectedly, reconnecting in 3s...`)
      setTimeout(() => {
        if (!this.intentionalClose && generation === conn.generation && conn.streams.size > 0) {
          this.connectSingle(conn)
        }
      }, 3000)
    })
  }
}
