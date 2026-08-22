import type { Exchange, UnifiedCandle } from '../types'
import { validateCandle } from './candle-utils'

const DB_NAME = 'crypto-screener-history'
const DB_VERSION = 1
const STORE_NAME = 'tails'
const RECORD_VERSION = 1
const PERSISTENT_TAIL_LIMIT = 300
const WRITE_DEBOUNCE_MS = 750
/**
 * A persisted tail older than this is treated as absent: the chart falls back
 * to the server round-trip instead of painting a days-old snapshot as "fast
 * path" and bridging the gap to now with live jumps. writtenAt was stored but
 * never checked — stale tails lived forever.
 */
const TAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface PersistentTailRecord {
  id: string
  version: typeof RECORD_VERSION
  writtenAt: number
  candles: UnifiedCandle[]
}

let dbPromise: Promise<IDBDatabase | null> | null = null
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingWrites = new Map<string, PersistentTailRecord>()

function recordKey(exchange: Exchange, symbol: string, tf: string): string {
  return `${exchange}:${symbol}:${tf}`
}

export function selectPersistentTail(candles: UnifiedCandle[]): UnifiedCandle[] {
  return candles.filter(validateCandle).slice(-PERSISTENT_TAIL_LIMIT)
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

async function writePending(id: string): Promise<void> {
  writeTimers.delete(id)
  const record = pendingWrites.get(id)
  pendingWrites.delete(id)
  if (!record) return
  const db = await openDatabase()
  if (!db) return
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(record)
  } catch { /* persistence is an optional fast path */ }
}

export function persistCandleTail(exchange: Exchange, symbol: string, tf: string, candles: UnifiedCandle[]): void {
  if (typeof indexedDB === 'undefined') return
  const selected = selectPersistentTail(candles)
  if (selected.length === 0) return
  const id = recordKey(exchange, symbol, tf)
  pendingWrites.set(id, { id, version: RECORD_VERSION, writtenAt: Date.now(), candles: selected })
  const existing = writeTimers.get(id)
  if (existing) clearTimeout(existing)
  writeTimers.set(id, setTimeout(() => { void writePending(id) }, WRITE_DEBOUNCE_MS))
}

export async function loadCandleTail(exchange: Exchange, symbol: string, tf: string): Promise<UnifiedCandle[]> {
  const db = await openDatabase()
  if (!db) return []
  return new Promise(resolve => {
    try {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(recordKey(exchange, symbol, tf))
      request.onsuccess = () => {
        const record = request.result as PersistentTailRecord | undefined
        if (!record || record.version !== RECORD_VERSION || !Array.isArray(record.candles)) return resolve([])
        // Expired tail = no data: fresher truth arrives from the server in
        // one round-trip, while a stale snapshot would paint days-old bars.
        if (!Number.isFinite(record.writtenAt) || Date.now() - record.writtenAt > TAIL_MAX_AGE_MS) {
          return resolve([])
        }
        resolve(selectPersistentTail(record.candles))
      }
      request.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}
