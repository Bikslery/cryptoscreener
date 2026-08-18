import { describe, it, expect } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { setLivePrice, setLivePriceEx } from '../../store'
import { useSmoothedPriceRef } from '../useSmoothedPrice'

function Price({ symbol, precision, initialPrice, prefix, exchange }: { symbol: string; precision: number; initialPrice?: number; prefix?: string; exchange?: string }) {
  const ref = useSmoothedPriceRef(symbol, precision, initialPrice, prefix, exchange)
  return <span data-testid="price" ref={ref} />
}

describe('useSmoothedPriceRef — direct DOM glide (no React render per frame)', () => {
  it('paints the initial price immediately with the prefix', () => {
    const { getByTestId } = render(<Price symbol="BTCUSDT" precision={2} initialPrice={100} prefix="$" />)
    expect(getByTestId('price').textContent).toBe('$100.00')
  })

  it('prefers the current live price over the initial fallback as the seed', () => {
    setLivePrice('LTCUSDT', 2000)
    const { getByTestId } = render(<Price symbol="LTCUSDT" precision={2} initialPrice={1990} prefix="$" />)
    expect(getByTestId('price').textContent).toBe('$2,000.00') // formatPrice uses thousand separators
  })

  it('glides to a new live price and converges on the shared coordinator', async () => {
    const { getByTestId, unmount } = render(<Price symbol="ETHUSDT" precision={2} initialPrice={1990} prefix="$" />)
    expect(getByTestId('price').textContent).toBe('$1,990.00')
    setLivePrice('ETHUSDT', 2010)
    await waitFor(() => expect(getByTestId('price').textContent).toBe('$2,010.00'), { timeout: 1500 })
    unmount()
  })

  it('shows nothing before the first price, then paints it immediately (no glide from nothing)', () => {
    const { getByTestId } = render(<Price symbol="DOGEUSDT" precision={4} prefix="$" />)
    expect(getByTestId('price').textContent).toBe('')
    setLivePrice('DOGEUSDT', 0.0706)
    expect(getByTestId('price').textContent).toBe('$0.0706')
  })

  it('exchange-scoped: reads only that exchange lane (other venue never leaks in)', async () => {
    const { getByTestId } = render(<Price symbol="BTCUSDT" precision={1} initialPrice={67000} prefix="$" exchange="binance-futures" />)
    expect(getByTestId('price').textContent).toBe('$67,000.0')
    // A SPOT print for the same symbol must NOT move a futures-scoped header.
    setLivePriceEx('BTCUSDT', 'binance-spot', 66999.5)
    expect(getByTestId('price').textContent).toBe('$67,000.0')
    // The futures lane (live pair → snap, no glide) moves it immediately.
    setLivePriceEx('BTCUSDT', 'binance-futures', 67123.5)
    await waitFor(() => expect(getByTestId('price').textContent).toBe('$67,123.5'))
  })
})
