export function formatPriceByPrecision(price: number, precision: number): string {
  if (!price || !isFinite(price)) return '0'
  if (price >= 1000 && precision <= 2) {
    return price.toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
  }
  return price.toFixed(precision)
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
