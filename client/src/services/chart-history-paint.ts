export type HistoryViewportAction = 'restore' | 'fit' | 'recent'

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
