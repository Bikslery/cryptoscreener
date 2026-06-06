import { useCallback, useRef } from 'react'
import { AudioLines } from 'lucide-react'
import { useCoinListStore } from '../../store'

const MIN_VOLUME_M = 0
const MAX_VOLUME_M = 250

function formatVolumeLabel(millions: number): string {
  if (millions <= 0) return '0M'
  if (millions >= 1000) return `${(millions / 1000).toFixed(1)}B`
  return `${Math.round(millions)}M`
}

export function VolumeSlider() {
  const minVolume24h = useCoinListStore(s => s.minVolume24h)
  const setMinVolume24h = useCoinListStore(s => s.setMinVolume24h)
  const sliderRef = useRef<HTMLDivElement>(null)

  const valueM = minVolume24h / 1_000_000
  const progressPct = ((valueM - MIN_VOLUME_M) / (MAX_VOLUME_M - MIN_VOLUME_M)) * 100

  const updateValueFromClientX = useCallback((clientX: number) => {
    const el = sliderRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = clientX - rect.left
    const pct = Math.max(0, Math.min(1, x / rect.width))
    const newM = Math.round(pct * (MAX_VOLUME_M - MIN_VOLUME_M) + MIN_VOLUME_M)
    setMinVolume24h(newM * 1_000_000)
  }, [setMinVolume24h])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    updateValueFromClientX(e.clientX)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return
    updateValueFromClientX(e.clientX)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      setMinVolume24h(Math.max(0, minVolume24h - step * 1_000_000))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      setMinVolume24h(Math.min(MAX_VOLUME_M * 1_000_000, minVolume24h + step * 1_000_000))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setMinVolume24h(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setMinVolume24h(MAX_VOLUME_M * 1_000_000)
    }
  }

  return (
    <div
      ref={sliderRef}
      className="volume-filter"
      style={{ ['--vs-progress' as string]: `${progressPct}%` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="slider"
      aria-label="Минимальный объём за 24 часа в миллионах"
      aria-valuemin={MIN_VOLUME_M}
      aria-valuemax={MAX_VOLUME_M}
      aria-valuenow={valueM}
      aria-valuetext={formatVolumeLabel(valueM)}
      title={`Минимальный объём 24ч: ${formatVolumeLabel(valueM)}`}
    >
      <AudioLines size={12} className="volume-filter-icon" strokeWidth={2} />
      <span className="volume-filter-label">24ч</span>
      <span className="volume-filter-value">{formatVolumeLabel(valueM)}</span>
    </div>
  )
}
