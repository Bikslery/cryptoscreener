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

  const valueM = minVolume24h / 1_000_000
  const progressPct = ((valueM - MIN_VOLUME_M) / (MAX_VOLUME_M - MIN_VOLUME_M)) * 100

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const m = Number.parseFloat(e.target.value)
    if (Number.isFinite(m)) {
      setMinVolume24h(m * 1_000_000)
    }
  }

  return (
    <div
      className="volume-filter"
      style={{ ['--vs-progress' as string]: `${progressPct}%` }}
      title={`Минимальный объём 24ч: ${formatVolumeLabel(valueM)}`}
    >
      <AudioLines size={12} className="volume-filter-icon" strokeWidth={2} />
      <span className="volume-filter-label">24ч</span>
      <span className="volume-filter-value">{formatVolumeLabel(valueM)}</span>
      <input
        type="range"
        min={MIN_VOLUME_M}
        max={MAX_VOLUME_M}
        step={1}
        value={valueM}
        onChange={onChange}
        aria-label="Минимальный объём за 24 часа в миллионах"
        aria-valuetext={formatVolumeLabel(valueM)}
        className="volume-filter-input"
      />
    </div>
  )
}
