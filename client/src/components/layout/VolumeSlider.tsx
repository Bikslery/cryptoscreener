import { useEffect, useRef, useState } from 'react'
import { AudioLines } from 'lucide-react'
import { useCoinListStore } from '../../store'

const MIN_VOLUME_M = 0
const MAX_VOLUME_M = 250

function formatVolumeLabel(millions: number): string {
  if (millions <= 0) return '$0'
  if (millions >= 1000) return `$${(millions / 1000).toFixed(1)}B`
  return `$${Math.round(millions)}M`
}

export function VolumeSlider() {
  const minVolume24h = useCoinListStore(s => s.minVolume24h)
  const setMinVolume24h = useCoinListStore(s => s.setMinVolume24h)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const valueM = minVolume24h / 1_000_000
  const progressPct = ((valueM - MIN_VOLUME_M) / (MAX_VOLUME_M - MIN_VOLUME_M)) * 100

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const m = Number.parseFloat(e.target.value)
    if (Number.isFinite(m)) {
      setMinVolume24h(m * 1_000_000)
    }
  }

  return (
    <div className="volume-filter" ref={wrapRef}>
      <button
        type="button"
        className={`volume-filter-button${open ? ' is-open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Минимальный объём 24ч: ${formatVolumeLabel(valueM)}`}
      >
        <AudioLines size={12} className="volume-filter-icon" strokeWidth={2} />
        <span className="volume-filter-label">24ч</span>
        <span className="volume-filter-value">{formatVolumeLabel(valueM)}</span>
      </button>

      {open && (
        <div className="volume-filter-popover" role="dialog" aria-label="Фильтр по минимальному объёму 24ч">
          <div className="volume-filter-popover-label">МИН. ОБЪЁМ 24Ч</div>
          <input
            type="range"
            min={MIN_VOLUME_M}
            max={MAX_VOLUME_M}
            step={1}
            value={valueM}
            onChange={onSliderChange}
            aria-label="Минимальный объём за 24 часа в миллионах"
            className="volume-slider"
            style={{ ['--vs-progress' as string]: `${progressPct}%` }}
          />
          <div className="volume-filter-popover-bounds">
            <span>$0</span>
            <span>$250M</span>
          </div>
        </div>
      )}
    </div>
  )
}
