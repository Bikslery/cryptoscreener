import { describe, it, expect } from 'vitest'
import { computeCursorAnchoredZoomRange } from '../chart-zoom'

const indexAt = (vr: { from: number; to: number }, width: number, x: number) =>
  vr.from + (x + 1) / (width / (vr.to - vr.from + 1)) - 0.5

describe('computeCursorAnchoredZoomRange', () => {
  const vr = { from: 100, to: 254 } // 155 bars visible
  const width = 430
  const x = 172 // 40% of the pane

  it('keeps the bar under the cursor at the same pixel when zooming out', () => {
    const next = computeCursorAnchoredZoomRange(vr, width, x, 100)!
    expect(next).not.toBeNull()
    expect(indexAt(next, width, x)).toBeCloseTo(indexAt(vr, width, x), 6)
  })

  it('keeps the bar under the cursor at the same pixel when zooming in', () => {
    const next = computeCursorAnchoredZoomRange(vr, width, x, -100)!
    expect(indexAt(next, width, x)).toBeCloseTo(indexAt(vr, width, x), 6)
  })

  it('widens the range when zooming out, narrows when zooming in', () => {
    const out = computeCursorAnchoredZoomRange(vr, width, x, 100)!
    const inn = computeCursorAnchoredZoomRange(vr, width, x, -100)!
    expect(out.to - out.from).toBeGreaterThan(vr.to - vr.from)
    expect(inn.to - inn.from).toBeLessThan(vr.to - vr.from)
  })

  it('range length matches the new bar spacing exactly', () => {
    const spacing = width / (vr.to - vr.from + 1)
    const out = computeCursorAnchoredZoomRange(vr, width, x, 100)!
    const inn = computeCursorAnchoredZoomRange(vr, width, x, -100)!
    expect(out.to - out.from + 1).toBeCloseTo(width / (spacing - 0.5), 6)
    expect(inn.to - inn.from + 1).toBeCloseTo(width / (spacing + 0.5), 6)
  })

  it('clamps spacing to the minimum — no more zooming out past minSpacing', () => {
    let r = { from: 100, to: 100 + width / 6 - 1 } // spacing 6
    for (let i = 0; i < 30; i++) {
      const next = computeCursorAnchoredZoomRange(r, width, x, 100) // zoom OUT
      if (!next) break
      r = next
    }
    const finalSpacing = width / (r.to - r.from + 1)
    expect(finalSpacing).toBeCloseTo(1, 6)
    // anchor still held after the whole zoom-in sequence
    expect(indexAt(r, width, x)).toBeCloseTo(indexAt({ from: 100, to: 100 + width / 6 - 1 }, width, x), 4)
  })

  it('handles cursor over the price axis (x beyond pane) without breaking', () => {
    const next = computeCursorAnchoredZoomRange(vr, width, 9999, 100)
    expect(next).not.toBeNull()
    expect(indexAt(next!, width, width)).toBeCloseTo(indexAt(vr, width, width), 6)
  })

  it('returns null for invalid input', () => {
    expect(computeCursorAnchoredZoomRange({ from: NaN, to: 254 }, width, x, 100)).toBeNull()
    expect(computeCursorAnchoredZoomRange(vr, 0, x, 100)).toBeNull()
    expect(computeCursorAnchoredZoomRange(vr, width, x, 100, 1, 30, 0)).toBeNull()
  })
})
