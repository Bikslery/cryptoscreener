import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { UnifiedTicker } from '../../../types'
import { Row } from '../CoinList'
import { VOLUME_HIGH_THRESHOLD } from '../../../constants/volume'

function makeCoin(quoteVolume24h: number): UnifiedTicker {
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    price: 100,
    change24h: 1.2,
    high24h: 110,
    low24h: 90,
    volume24h: 1000,
    trades24h: 500,
    quoteVolume24h,
    range1m: 0.5,
    natr5m: 0.3,
    pricePrecision: 2,
    timestamp: 0,
  }
}

function renderRow(quoteVolume24h: number) {
  const { getByTestId } = render(
    <Row
      coin={makeCoin(quoteVolume24h)}
      isSelected={false}
      isOnPage={false}
      isNextOnPage={false}
      isWatched={false}
      onClick={vi.fn()}
      onPrefetch={vi.fn()}
      onToggleWatch={vi.fn()}
    />,
  )
  return getByTestId('vol-cell')
}

function renderBaseRow(overrides: Partial<Parameters<typeof Row>[0]> = {}) {
  const props = {
    coin: makeCoin(1000),
    isSelected: false,
    isOnPage: false,
    isNextOnPage: false,
    isWatched: false,
    onClick: vi.fn(),
    onPrefetch: vi.fn(),
    onToggleWatch: vi.fn(),
    ...overrides,
  }
  return { ...render(<Row {...props} />), props }
}

describe('CoinList Row — live price cell', () => {
  it('paints the initial price immediately (no glide from nothing)', () => {
    const { getByTestId } = renderBaseRow()
    const cell = getByTestId('price-cell')
    expect(cell.textContent).toBe('100.00')
  })

  it('glides the displayed value toward the live price on the shared coordinator', () => {
    const { getByTestId, unmount } = renderBaseRow()
    const cell = getByTestId('price-cell')
    expect(cell.textContent).toBe('100.00')
    unmount() // no stray rAF frames after teardown (glider unregisters)
  })
})

describe('CoinList Row — watchlist star', () => {
  it('toggles the watch on click without selecting the row', () => {
    const onClick = vi.fn()
    const onToggleWatch = vi.fn()
    const { getByTestId } = renderBaseRow({ onClick, onToggleWatch })
    fireEvent.click(getByTestId('watch-toggle'))
    expect(onToggleWatch).toHaveBeenCalledWith('BTCUSDT')
    expect(onClick).not.toHaveBeenCalled() // star must not open the chart
  })

  it('renders the star filled when watched', () => {
    const { getByTestId } = renderBaseRow({ isWatched: true })
    expect(getByTestId('watch-toggle').className).toContain('text-[#f5c518]')
  })

  it('renders the star dim when not watched', () => {
    const { getByTestId } = renderBaseRow({ isWatched: false })
    expect(getByTestId('watch-toggle').className).not.toContain('text-[#f5c518]')
  })
})

describe('CoinList Row — volume highlight', () => {
  it('renders high volume (>= threshold) in bright white', () => {
    const cell = renderRow(VOLUME_HIGH_THRESHOLD)
    expect(cell.className).toContain('text-[#fff]')
    expect(cell.className).toContain('font-medium')
    expect(cell.className).not.toContain('text-[#a0a0a0]')
  })

  it('renders volume above threshold in bright white', () => {
    const cell = renderRow(VOLUME_HIGH_THRESHOLD + 1)
    expect(cell.className).toContain('text-[#fff]')
  })

  it('renders low volume (< threshold) in grey', () => {
    const cell = renderRow(VOLUME_HIGH_THRESHOLD - 1)
    expect(cell.className).toContain('text-[#a0a0a0]')
    expect(cell.className).not.toContain('text-[#fff]')
  })
})
