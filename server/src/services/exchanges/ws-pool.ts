import WebSocket from 'ws'
import type { Agent } from 'http'

const MAX_STREAMS_PER_CONN = 200

interface PoolConn {
  ws: WebSocket | null
  streams: Set<string>
  generation: number
}

export class WsStreamPool {
  private baseUrl: string
  private name: string
  private onMessage: (msg: any) => void
  private agent: Agent | undefined
  private connections: PoolConn[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false

  constructor(baseUrl: string, name: string, onMessage: (msg: any) => void, agent?: Agent) {
    this.baseUrl = baseUrl
    this.name = name
    this.onMessage = onMessage
    this.agent = agent
  }

  addStream(stream: string) {
    let target = this.connections.find(c => c.streams.size < MAX_STREAMS_PER_CONN)
    if (!target) {
      target = { ws: null, streams: new Set(), generation: 0 }
      this.connections.push(target)
    }
    const isNew = !target.streams.has(stream)
    target.streams.add(stream)
    if (isNew) this.scheduleReconnect()
  }

  removeStream(stream: string) {
    for (const conn of this.connections) {
      if (!conn.streams.delete(stream)) continue
      if (conn.streams.size === 0 && conn.ws) {
        conn.generation++
        try { conn.ws.close() } catch {}
        conn.ws = null
      }
    }
    this.connections = this.connections.filter(c => c.streams.size > 0)
    this.scheduleReconnect()
  }

  get size(): number {
    return this.connections.reduce((sum, c) => sum + c.streams.size, 0)
  }

  close() {
    this.intentionalClose = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    for (const conn of this.connections) {
      if (conn.ws) {
        conn.generation++
        try { conn.ws.close() } catch {}
        conn.ws = null
      }
    }
    this.connections = []
  }

  private wsOpts(): WebSocket.ClientOptions | undefined {
    return this.agent ? { agent: this.agent } : undefined
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doReconnect()
    }, 300)
  }

  private doReconnect() {
    for (const conn of this.connections) {
      if (conn.ws) {
        conn.generation++
        try { conn.ws.close() } catch {}
        conn.ws = null
      }
    }

    if (this.connections.length === 0) return

    this.intentionalClose = false

    for (const conn of this.connections) {
      if (conn.streams.size === 0) continue
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

  private connectSingle(conn: PoolConn) {
    if (conn.streams.size === 0 || conn.ws?.readyState === WebSocket.OPEN) return
    const streams = Array.from(conn.streams).join('/')
    const url = `${this.baseUrl}?streams=${streams}`
    const generation = ++conn.generation

    conn.ws = new WebSocket(url, this.wsOpts())
    conn.ws.on('open', () => {
      console.log(`[${this.name}] WS reconnected (${conn.streams.size} streams)`)
    })
    conn.ws.on('message', (raw) => {
      try { this.onMessage(JSON.parse(raw.toString())) } catch {}
    })
    conn.ws.on('error', (err) => {
      console.error(`[${this.name}] WS error:`, err.message || err)
    })
    conn.ws.on('close', () => {
      if (this.intentionalClose || generation !== conn.generation) return
      setTimeout(() => {
        if (!this.intentionalClose && generation === conn.generation) this.connectSingle(conn)
      }, 3000)
    })
  }
}
