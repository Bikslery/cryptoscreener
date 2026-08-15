import { create } from 'zustand'
import type { DensitySnapshot, DensityWall, DensitySymbolBrp } from '../types.js'
import { wsOnType, wsSubscribe } from '../services/ws.js'
import api from '../services/api.js'

interface DensityStore {
  ts: number
  walls: DensityWall[]
  autoBrps: DensitySymbolBrp[]
  init: () => () => void
}

export const useDensityStore = create<DensityStore>((set, get) => ({
  ts: 0,
  walls: [],
  autoBrps: [],

  init: () => {
    const unsub = wsOnType('density', (msg) => {
      const data = msg.data as DensitySnapshot | undefined
      if (!data || !Array.isArray(data.walls)) return
      set({
        ts: data.ts ?? Date.now(),
        walls: data.walls,
        autoBrps: Array.isArray(data.autoBrps) ? data.autoBrps : get().autoBrps,
      })
    })

    wsSubscribe('density')

    // REST bootstrap: fill the store from the last snapshot instead of
    // waiting for the next 2s WS push.
    api.get('/density', { params: { limit: 1000 } })
      .then((res) => {
        const data = res.data as DensitySnapshot | undefined
        if (!data || !Array.isArray(data.walls)) return
        if (data.walls.length === 0) return
        if (get().ts !== 0) return // WS already landed a fresher snapshot
        set({
          ts: data.ts ?? Date.now(),
          walls: data.walls,
          autoBrps: Array.isArray(data.autoBrps) ? data.autoBrps : [],
        })
      })
      .catch(() => { /* WS snapshot covers */ })

    return unsub
  },
}))
