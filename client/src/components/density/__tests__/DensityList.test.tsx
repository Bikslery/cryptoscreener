import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { DensityWall, UnifiedTicker } from '../../../types'

const densityState: { walls: DensityWall[]; autoBrps: [] } = { walls: [], autoBrps: [] }
const coinState: {
  expandedSymbol: string | null
  selectedSymbol: string | null
  expandChartAtPrice: (symbol: string, price: number) => void
} = {
  expandedSymbol: 'BTCUSDT',
  selectedSymbol: null,
  expandChartAtPrice: vi.fn(),
}

vi.mock('../../../store/density', () => ({
  useDensityStore: (sel: (s: { walls: DensityWall[]; autoBrps: [] }) => unknown) => sel(densityState),
}))

vi.mock('../../../store', () => ({
  useCoinListStore: (sel: (s: typeof coinState & { coinMap: Map<string, UnifiedTicker> }) => unknown) =>
    sel({ ...coinState, coinMap: new Map([['BTCUSDT', makeCoin()]]) }),
  useAuthStore: (sel: (s: { settings: Record<string, never> | null }) => unknown) =>
    sel({ settings: null }),
}))

import { DensityList } from '../DensityList'

function makeCoin(): UnifiedTicker {
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    price: 100,
    change24h: 0,
    high24h: 110,
    low24h: 90,
    volume24h: 1,
    trades24h: 1,
    quoteVolume24h: 1,
    range1m: 0,
    natr5m: 0,
    corrBtc: null,
    tradesSpike: null,
    volumeSpike: null,
    pricePrecision: 2,
    timestamp: 0,
  }
}

function wall(overrides: Partial<DensityWall> = {}): DensityWall {
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance-futures',
    side: 'ask',
    price: 101,
    sizeUsdt: 1_200_000,
    bornAt: Date.now() - 35 * 60_000, // 35 минут назад — пережила 30-мин порог
    roundNumber: false,
    ...overrides,
  }
}

beforeEach(() => {
  densityState.walls = []
  coinState.expandedSymbol = 'BTCUSDT'
  coinState.selectedSymbol = null
  vi.mocked(coinState.expandChartAtPrice).mockClear()
})

describe('DensityList', () => {
  it('shows ask and bid sections with badge, size and age for tiered walls', () => {
    densityState.walls = [
      wall({ side: 'ask', price: 101, sizeUsdt: 1_200_000 }),
      wall({ side: 'bid', price: 99, sizeUsdt: 2_000_000 }),
    ]
    render(<DensityList />)

    expect(screen.getByText('ПРОДАЖА (аски)')).toBeTruthy()
    expect(screen.getByText('ПОКУПКА (биды)')).toBeTruthy()
    expect(screen.getAllByText('BI-F').length).toBe(2)
    expect(screen.getByText('1.20M')).toBeTruthy()
    expect(screen.getByText('2.00M')).toBeTruthy()
    // возраст ~35 минут
    expect(screen.getAllByText('35м').length).toBe(2)
  })

  it('hides walls that have not lived past the 30-minute tier lifetime', () => {
    densityState.walls = [
      wall({ bornAt: Date.now() - 10_000 }), // 10 секунд — спуф
      wall({ bornAt: Date.now() - 10 * 60_000 }), // 10 минут — ещё молодая
      wall({ bornAt: Date.now() - 35 * 60_000 }), // 35 минут — устоявшаяся
    ]
    render(<DensityList />)

    expect(screen.getAllByRole('button').filter(b => b.title.includes('ask')).length).toBe(1)
    expect(screen.getByText(/плотностей: 1/)).toBeTruthy()
  })

  it('renders the empty state when the symbol has no tiered walls', () => {
    densityState.walls = [wall({ symbol: 'ETHUSDT' })]
    render(<DensityList />)

    expect(screen.getByText(/Нет плотностей для BTC/)).toBeTruthy()
  })

  it('asks to pick a coin when nothing is selected', () => {
    coinState.expandedSymbol = null
    coinState.selectedSymbol = null
    render(<DensityList />)

    expect(screen.getByText(/Выберите монету/)).toBeTruthy()
  })

  it('focuses the chart on the wall price on row click', () => {
    densityState.walls = [wall({ price: 123.45 })]
    render(<DensityList />)

    fireEvent.click(screen.getAllByRole('button').find(b => b.title.includes('ask'))!)
    expect(coinState.expandChartAtPrice).toHaveBeenCalledWith('BTCUSDT', 123.45)
  })
})
