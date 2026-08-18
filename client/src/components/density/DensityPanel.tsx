import { memo } from 'react'
import { DensityMap } from './DensityMap'

/**
 * Панель плотностей: двумерная карта всех плотностей по тирам и расстоянию
 * (режим «Карта», как у scalpboard).
 */
export const DensityPanel = memo(function DensityPanel() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        <DensityMap />
      </div>
    </div>
  )
})