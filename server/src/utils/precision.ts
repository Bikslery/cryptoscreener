export function precisionFromTickSize(tickSize: string | number): number {
  const str = String(tickSize)
  const dotIndex = str.indexOf('.')
  if (dotIndex === -1) return 0
  const trimmed = str.replace(/0+$/, '')
  const trimmedDotIndex = trimmed.indexOf('.')
  if (trimmedDotIndex === -1) return 0
  return trimmed.length - trimmedDotIndex - 1
}

export function fallbackPrecision(price: number): number {
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
