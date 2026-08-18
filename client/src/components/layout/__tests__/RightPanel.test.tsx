import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RightPanel } from '../RightPanel'

vi.mock('../../coinlist/CoinList', () => ({
  CoinList: () => <div data-testid="mock-coinlist" />,
}))

vi.mock('../../alerts/AlertStack', () => ({
  AlertStack: () => <div data-testid="mock-alerts" />,
}))

vi.mock('../../density/DensityPanel', () => ({
  DensityPanel: () => <div data-testid="mock-density" />,
}))

const ACTIVE_KEY = 'rightPanel.active.v1'
const SPLIT_KEY = 'rightPanel.split.v1'

function renderPanel() {
  return render(<RightPanel width={420} />)
}

function toggle(key: 'tickers' | 'alerts' | 'density') {
  fireEvent.click(screen.getByTestId(`panel-toggle-${key}`))
}

describe('RightPanel — panel toggles', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders only the ticker list by default', () => {
    renderPanel()
    expect(screen.getByTestId('mock-coinlist')).toBeTruthy()
    expect(screen.queryByTestId('mock-alerts')).toBeNull()
    expect(screen.queryByTestId('mock-density')).toBeNull()
    expect(screen.queryByTestId('panel-splitter')).toBeNull()
  })

  it('turns panels on and off as independent toggles', () => {
    renderPanel()
    toggle('alerts')
    expect(screen.getByTestId('mock-alerts')).toBeTruthy()
    expect(screen.getByTestId('mock-coinlist')).toBeTruthy()
    toggle('alerts')
    expect(screen.queryByTestId('mock-alerts')).toBeNull()
    expect(screen.getByTestId('mock-coinlist')).toBeTruthy()
  })

  it('keeps all three panels on at once', () => {
    renderPanel()
    toggle('alerts')
    toggle('density')
    expect(screen.getByTestId('mock-coinlist')).toBeTruthy()
    expect(screen.getByTestId('mock-alerts')).toBeTruthy()
    expect(screen.getByTestId('mock-density')).toBeTruthy()
    expect(screen.getAllByTestId('panel-splitter')).toHaveLength(2)
  })

  it('refuses to turn off the last active panel', () => {
    renderPanel()
    toggle('tickers')
    expect(screen.getByTestId('panel-toggle-tickers').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('mock-coinlist')).toBeTruthy()
    expect(screen.queryByTestId('mock-alerts')).toBeNull()
  })

  it('allows turning a panel off while another stays active', () => {
    renderPanel()
    toggle('alerts')
    toggle('tickers')
    expect(screen.queryByTestId('mock-coinlist')).toBeNull()
    expect(screen.getByTestId('mock-alerts')).toBeTruthy()
    expect(screen.getByTestId('panel-toggle-tickers').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('RightPanel — localStorage restore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores the active panel set', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: false, alerts: true, density: true }))
    renderPanel()
    expect(screen.queryByTestId('mock-coinlist')).toBeNull()
    expect(screen.getByTestId('mock-alerts')).toBeTruthy()
    expect(screen.getByTestId('mock-density')).toBeTruthy()
  })

  it('restores a two-panel split from localStorage', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: true, alerts: false, density: true }))
    localStorage.setItem(SPLIT_KEY, '30')
    renderPanel()
    expect(screen.getByTestId('panel-tickers').style.height).toBe('30%')
    expect(screen.getByTestId('panel-density').style.height).toBe('70%')
  })

  it('restores a three-panel split from localStorage', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: true, alerts: true, density: true }))
    localStorage.setItem(SPLIT_KEY, JSON.stringify([20, 50]))
    renderPanel()
    expect(screen.getByTestId('panel-tickers').style.height).toBe('20%')
    expect(screen.getByTestId('panel-alerts').style.height).toBe('50%')
    expect(screen.getByTestId('panel-density').style.height).toBe('30%')
  })

  it('falls back to defaults on invalid active data', () => {
    localStorage.setItem(ACTIVE_KEY, '{broken json')
    localStorage.setItem(SPLIT_KEY, '"not a number"')
    renderPanel()
    expect(screen.getByTestId('mock-coinlist')).toBeTruthy()
    expect(screen.queryByTestId('panel-splitter')).toBeNull()
  })

  it('falls back to defaults when every panel is disabled in storage', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: false, alerts: false, density: false }))
    renderPanel()
    expect(screen.getByTestId('mock-coinlist')).toBeTruthy()
    expect(screen.queryByTestId('mock-alerts')).toBeNull()
  })

  it('uses 50/50 when no split is stored', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: true, alerts: true, density: false }))
    renderPanel()
    expect(screen.getByTestId('panel-tickers').style.height).toBe('50%')
    expect(screen.getByTestId('panel-alerts').style.height).toBe('50%')
  })

  it('persists the active set after a toggle', () => {
    renderPanel()
    toggle('alerts')
    expect(JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? 'null')).toEqual({
      tickers: true,
      alerts: true,
      density: false,
    })
  })
})

describe('RightPanel — splitter', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
  })

  it('drags the splitter and persists the new split', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: true, alerts: false, density: true }))
    renderPanel()
    const splitter = screen.getByTestId('panel-splitter')
    fireEvent.pointerDown(splitter, { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 240 })
    fireEvent.pointerUp(splitter, { pointerId: 1, clientY: 240 })
    expect(screen.getByTestId('panel-tickers').style.height).toBe('40%')
    expect(screen.getByTestId('panel-density').style.height).toBe('60%')
    expect(JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null')).toBe(40)
  })

  it('clamps the top panel to a minimum height while dragging', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: true, alerts: false, density: true }))
    renderPanel()
    const splitter = screen.getByTestId('panel-splitter')
    fireEvent.pointerDown(splitter, { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 0 })
    fireEvent.pointerUp(splitter, { pointerId: 1, clientY: 0 })
    expect(screen.getByTestId('panel-tickers').style.height).toBe('20%')
    expect(screen.getByTestId('panel-density').style.height).toBe('80%')
  })

  it('resets the split to 50/50 on double-click and persists', () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ tickers: true, alerts: false, density: true }))
    localStorage.setItem(SPLIT_KEY, '30')
    renderPanel()
    fireEvent.doubleClick(screen.getByTestId('panel-splitter'))
    expect(screen.getByTestId('panel-tickers').style.height).toBe('50%')
    expect(screen.getByTestId('panel-density').style.height).toBe('50%')
    expect(JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null')).toBe(50)
  })
})
