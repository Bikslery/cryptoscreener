import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = CONNECTING
  static OPEN = OPEN
  static CLOSING = CLOSING
  static CLOSED = CLOSED

  readyState: number = CONNECTING
  binaryType: string = ''
  closed = false
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null

  url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.readyState = CLOSED
    this.onclose?.()
  }

  open() {
    this.readyState = OPEN
    this.onopen?.()
  }
}

type WsModule = typeof import('../ws')

async function freshWs(): Promise<WsModule> {
  return await import('../ws')
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ws self-heal', () => {
  it('watchdog tears down a silent OPEN socket and reconnects', async () => {
    vi.useFakeTimers()
    const wsMod = await freshWs()
    wsMod.wsConnect()
    const a = FakeWebSocket.instances[0]
    a.open()
    // 60s of silence: lastMessageAt only refreshed by inbound data, so the
    // socket reads as stale (>45s) — half-open TCP death with no FIN.
    vi.advanceTimersByTime(60_000)
    expect(a.closed).toBe(true)
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('watchdog kills a handshake stuck in CONNECTING and retries', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wsMod = await freshWs()
    wsMod.wsConnect()
    const a = FakeWebSocket.instances[0]
    // Handshake never settles.
    vi.advanceTimersByTime(15_000)
    expect(a.closed).toBe(true)
    // scheduleReconnect: base 1s with random=0
    vi.advanceTimersByTime(1_001)
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('ensureHealthyConnection retries a handshake stuck in CONNECTING', async () => {
    vi.useFakeTimers()
    const wsMod = await freshWs()
    wsMod.wsConnect()
    const a = FakeWebSocket.instances[0]
    vi.advanceTimersByTime(11_000)
    wsMod.ensureHealthyConnection()
    expect(a.closed).toBe(true)
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('onerror closes its own socket and the reconnect timer fires', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wsMod = await freshWs()
    wsMod.wsConnect()
    const a = FakeWebSocket.instances[0]
    a.open()
    a.onerror?.()
    expect(a.closed).toBe(true)
    // onclose → scheduleReconnect → 1s later a new socket
    vi.advanceTimersByTime(1_001)
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('wsDisconnect suppresses watchdog and reconnect (logout)', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wsMod = await freshWs()
    wsMod.wsConnect()
    const a = FakeWebSocket.instances[0]
    a.open()
    wsMod.wsDisconnect()
    expect(a.closed).toBe(true)
    // Long silence — the watchdog must NOT resurrect the connection.
    vi.advanceTimersByTime(120_000)
    expect(FakeWebSocket.instances.length).toBe(1)
  })
})
