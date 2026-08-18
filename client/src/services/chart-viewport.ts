import type { IChartApi } from 'lightweight-charts'

/**
 * Viewport save/restore (scalpboard's Os/ae equivalent).
 *
 * Scalpboard persists the time-scale state per market and restores it when
 * data for that market loads again: barSpacing, rightOffset, timeVisible and
 * the scroll position. The alternative — restoring a LOGICAL range — snaps
 * to grid indices and loses the exact bar-to-pixel mapping (and can never
 * express "empty space beyond the last bar" precisely). scrollPosition()
 * (logical offset) + scrollToPosition() is the lightweight-charts equivalent
 * of the scroll capture; the pixel-exactness comes from barSpacing being
 * restored as-is, so the bar-to-pixel mapping is identical to before the
 * reload.
 *
 * The map is keyed by `${exchange}:${symbol}:${tf}` and lives for the whole
 * session so switching away and back restores exactly where the user left.
 */

export interface ChartViewport {
  barSpacing: number
  rightOffset: number
  timeVisible: boolean
  scrollPos: number
}

const viewportMap = new Map<string, ChartViewport>()

export function saveViewport(key: string, vp: ChartViewport | null): void {
  if (!vp) return
  viewportMap.set(key, vp)
}

export function getViewport(key: string): ChartViewport | null {
  return viewportMap.get(key) ?? null
}

export function captureViewport(chart: IChartApi | null | undefined): ChartViewport | null {
  if (!chart) return null
  try {
    const ts = chart.timeScale()
    const o = ts.options()
    return {
      barSpacing: o.barSpacing ?? 6,
      rightOffset: o.rightOffset ?? 0,
      timeVisible: o.timeVisible ?? false,
      scrollPos: ts.scrollPosition(),
    }
  } catch {
    // The time scale may be mid-render — never break a paint for a capture.
    return null
  }
}

export function restoreViewport(chart: IChartApi | null | undefined, vp: ChartViewport): void {
  if (!chart) return
  try {
    const ts = chart.timeScale()
    ts.applyOptions({
      barSpacing: vp.barSpacing,
      rightOffset: vp.rightOffset,
      timeVisible: vp.timeVisible,
    })
    ts.scrollToPosition(vp.scrollPos, false)
  } catch {
    // No data yet — the next paint restores the viewport instead.
  }
}