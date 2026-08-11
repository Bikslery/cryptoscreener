export interface ZoomVisibleRange {
  from: number
  to: number
}

/**
 * Compute the new visible logical range for a cursor-anchored zoom (ctrl/cmd+
 * wheel or trackpad pinch): the bar under the cursor must stay at the same
 * pixel, so zooming in/out never shifts what the user is looking at.
 *
 * Pure math over lightweight-charts' coordinate mapping
 *   x = width - (vr.to - i + 0.5) * spacing - 1
 * (inverse: float logical at pixel x = vr.from + (x + 1) / spacing - 0.5).
 *
 * Everything is derived from the PRE-zoom visible range — nothing is read
 * after the range/spacing are applied, because LWC applies options
 * asynchronously and `coordinateToLogical` is integer-rounded, so both are
 * unreliable mid-zoom.
 *
 * @param vr      current visible logical range [from, to]
 * @param width   time-scale width in pixels
 * @param x       cursor x inside the time scale (0..width)
 * @param deltaY  wheel delta; positive = zoom out, negative = zoom in
 * @returns the new visible range, or null if no zoom step applies
 */
export function computeCursorAnchoredZoomRange(
  vr: ZoomVisibleRange,
  width: number,
  x: number,
  deltaY: number,
  minSpacing = 1,
  maxSpacing = 30,
  step = 0.5,
): ZoomVisibleRange | null {
  if (!vr || width <= 0 || !isFinite(vr.from) || !isFinite(vr.to)) return null
  const spacing = width / (vr.to - vr.from + 1)
  const newSpacing = Math.max(minSpacing, Math.min(maxSpacing, spacing + (deltaY > 0 ? -step : step)))
  if (Math.abs(newSpacing - spacing) < 1e-9) return null
  const cx = Math.max(0, Math.min(width, x))
  // Float logical index of the bar under the cursor (before the zoom).
  const anchor = vr.from + (cx + 1) / spacing - 0.5
  // New range that keeps `anchor` at the same pixel:
  //   from = anchor - (cx + 1) / newSpacing + 0.5,  to - from = width/newSpacing - 1.
  // setVisibleLogicalRange re-derives barSpacing from the range length, so the
  // new spacing is applied together with the scroll in one consistent step.
  const from = anchor - (cx + 1) / newSpacing + 0.5
  const to = from + width / newSpacing - 1
  return { from, to }
}
