import type { IChartApi } from 'lightweight-charts'

export type HistoryViewportAction = 'restore' | 'fit' | 'recent'
type FrameScheduler = (callback: FrameRequestCallback) => number

/**
 * A non-empty cache/WS tail is useful for the first paint. The deeper REST
 * history may arrive later, but the user should never wait on it to see a
 * live chart.
 */
export function canPaintPartialHistory(candleCount: number): boolean {
  return Number.isFinite(candleCount) && candleCount > 0
}

/**
 * Updating a series with setData resets lightweight-charts' time scale.
 * Once a viewport exists, restoring it must win over fitContent so a
 * background history top-up cannot visibly zoom or move the chart.
 */
export function resolveHistoryViewportAction(options: {
  hasViewport: boolean
  fitOnOpen: boolean
}): HistoryViewportAction {
  if (options.hasViewport) return 'restore'
  return options.fitOnOpen ? 'fit' : 'recent'
}

/**
 * lightweight-charts recalculates its price scale when `series.setData()`
 * replaces a short visible tail with deeper history. Even when the time
 * viewport is restored synchronously, that autoscale can paint one frame at
 * a different vertical range and makes the chart visibly twitch.
 *
 * Freeze the current price range for the replacement frame. Autoscale is
 * restored on the next animation frame, after the caller has restored the
 * time viewport, so future live prices still adjust the chart normally.
 */
export function replaceDataPreservingPriceScale(
  chart: IChartApi | null | undefined,
  replaceData: () => void,
  scheduleFrame: FrameScheduler = callback => requestAnimationFrame(callback),
): void {
  if (!chart) {
    replaceData()
    return
  }

  let priceScale: ReturnType<IChartApi['priceScale']>
  let visibleRange: { from: number; to: number } | null
  let wasAutoScale: boolean
  try {
    priceScale = chart.priceScale('right')
    visibleRange = priceScale.getVisibleRange()
    wasAutoScale = priceScale.options().autoScale
  } catch {
    replaceData()
    return
  }

  if (!visibleRange) {
    replaceData()
    return
  }

  try {
    if (wasAutoScale) priceScale.setAutoScale(false)
    priceScale.setVisibleRange(visibleRange)
    replaceData()
  } finally {
    try {
      priceScale.setVisibleRange(visibleRange)
      if (wasAutoScale) {
        try {
          scheduleFrame(() => {
            try {
              // The time viewport is final now; autoscale can safely resume.
              priceScale.setAutoScale(true)
            } catch { /* chart was destroyed before the next frame */ }
          })
        } catch {
          // Never leave a live chart permanently locked if frame scheduling
          // is unavailable (defensive fallback for non-browser runtimes).
          priceScale.setAutoScale(true)
        }
      }
    } catch { /* price scale was destroyed during replacement */ }
  }
}
