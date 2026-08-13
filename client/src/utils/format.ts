export function getPrecisionFromTickSize(tickSize: string | number): number {
  const str = String(tickSize)
  const dotIndex = str.indexOf('.')
  if (dotIndex === -1) return 0
  const trimmed = str.replace(/0+$/, '')
  const trimmedDotIndex = trimmed.indexOf('.')
  if (trimmedDotIndex === -1) return 0
  return trimmed.length - trimmedDotIndex - 1
}

export function getPrecisionFromPrice(price: number): number {
  if (price <= 0 || !isFinite(price)) return 2
  const str = price.toPrecision(15)
  const dotIndex = str.indexOf('.')
  if (dotIndex === -1) return 2
  let firstSignificant = -1
  for (let i = dotIndex + 1; i < str.length; i++) {
    if (str[i] !== '0' && str[i] !== 'e' && str[i] !== 'E') {
      firstSignificant = i
      break
    }
  }
  if (firstSignificant === -1) return 2
  if (price >= 1) return Math.max(2, firstSignificant - dotIndex)
  return firstSignificant - dotIndex + 3
}

export function formatPrice(price: number, precision: number): string {
  if (!price || !isFinite(price)) return ''
  if (price >= 1000 && precision <= 2) {
    return price.toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
  }
  return price.toFixed(precision)
}

const COMPACT_UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

/**
 * Compact number for volumes (24h quote volume in the coin list and chart
 * headers). Rounds to 1 decimal below 100 ("1.5K", "12.3M") and to whole
 * units at 100+ ("123K"), trims a trailing ".0", and carries over the unit
 * boundary when rounding would overflow it — no "1000K" / "2K"-for-1500
 * artifacts, no "1234.6B" where "1.2T" fits.
 */
export function formatCompact(n: number): string {
  if (!isFinite(n)) return String(n)
  if (n < 0) return `-${formatCompact(-n)}`
  let div = 1
  let suffix = ''
  for (const [d, s] of COMPACT_UNITS) {
    if (n >= d) { div = d; suffix = s; break }
  }
  // Round first, then carry over the boundary if rounding fills a unit
  // (999.999K rounds to 1000 -> "1M").
  let v = n / div
  let rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
  if (rounded >= 1000 && suffix) {
    const i = COMPACT_UNITS.findIndex(u => u[1] === suffix)
    if (i === 0) return String(Math.round(n)) // T overflows — raw number
    div = COMPACT_UNITS[i - 1][0]
    suffix = COMPACT_UNITS[i - 1][1]
    v = n / div
    rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
  }
  const s = v >= 100 ? String(rounded) : rounded.toFixed(1)
  return s.replace(/\.0$/, '') + suffix
}

const QUOTE_ASSETS = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH', 'BNB', 'TUSD', 'DAI']

export function extractBaseAsset(symbol: string): string {
  if (!symbol) return ''
  for (const sep of ['/', '-', '_']) {
    const idx = symbol.indexOf(sep)
    if (idx > 0) return symbol.slice(0, idx).toUpperCase()
  }
  for (const quote of QUOTE_ASSETS) {
    if (symbol.length > quote.length && symbol.toUpperCase().endsWith(quote)) {
      return symbol.slice(0, -quote.length).toUpperCase()
    }
  }
  return symbol.toUpperCase()
}
