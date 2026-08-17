import { describe, it, expect } from 'vitest'
import { birthBarIndex } from '../overlays/DensityPrimitive'

// Bars on a 1m chart, aligned to minute boundaries (chart-time space).
const BARS = [0, 60, 120, 180, 240, 300, 360, 420, 480]

describe('birthBarIndex', () => {
  it('returns -1 on an empty timeline', () => {
    expect(birthBarIndex([], 120)).toBe(-1)
  })

  it('returns -1 when the birth predates every bar', () => {
    expect(birthBarIndex(BARS, -60)).toBe(-1)
  })

  it('anchors an exact bar-aligned birth to that bar', () => {
    // born exactly at 00:03:00 -> the 180s bar
    expect(birthBarIndex(BARS, 180)).toBe(3)
  })

  it('anchors a birth inside a bar to the CONTAINING (creation) bar', () => {
    // born at 00:03:43 -> the candle that was forming is the 180s bar
    expect(birthBarIndex(BARS, 183)).toBe(3)
  })

  it('anchors a birth after the last bar to the last bar', () => {
    // born in the current (forming) period, past all finished bars
    expect(birthBarIndex(BARS, 500)).toBe(8)
  })

  it('anchors across a data gap to the last bar before the birth', () => {
    // bars jump 180s -> 300s (a quiet minute is missing). Birth at 240s
    // falls in the gap: the containing bar is 180s, NOT the snapped 240s.
    const gapped = [0, 60, 120, 180, 300, 360]
    expect(birthBarIndex(gapped, 240)).toBe(3)
  })
})