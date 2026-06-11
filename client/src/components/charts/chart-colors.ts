/**
 * CSS-variable driven chart colors, read once and cached.
 *
 * Previously UP_COLOR_VOL()/DOWN_COLOR_VOL() called getComputedStyle for
 * EVERY candle inside .map() loops — thousands of forced style recalcs per
 * grid load. Now the variables are resolved once at first use; call
 * refreshChartColors() if the theme changes at runtime.
 */
function getCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

interface ChartColors {
  up: string
  down: string
  upVol: string
  downVol: string
  upBorder: string
  downBorder: string
}

let cached: ChartColors | null = null

function readColors(): ChartColors {
  return {
    up: getCssVar('--chart--candle-up', '#26a65b'),
    down: getCssVar('--chart--candle-down', '#e74c3c'),
    upVol: getCssVar('--chart--candle-up-vol', 'rgba(38,166,91,0.27)'),
    downVol: getCssVar('--chart--candle-down-vol', 'rgba(231,76,60,0.27)'),
    upBorder: getCssVar('--chart--candle-border-up', '#26a65b'),
    downBorder: getCssVar('--chart--candle-border-down', '#e74c3c'),
  }
}

function colors(): ChartColors {
  if (!cached) cached = readColors()
  return cached
}

/** Invalidate the cache (call after a theme change). */
export function refreshChartColors(): void {
  cached = null
}

export const UP_COLOR = () => colors().up
export const DOWN_COLOR = () => colors().down
export const UP_COLOR_VOL = () => colors().upVol
export const DOWN_COLOR_VOL = () => colors().downVol
export const UP_BORDER = () => colors().upBorder
export const DOWN_BORDER = () => colors().downBorder
