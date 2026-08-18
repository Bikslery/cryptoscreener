/**
 * Pure wall-lifecycle helpers for the density engine.
 *
 * A wall's identity is fragile: its key is tied to a price-bucket index on a
 * grid that moves with the mid price, and a cluster can dip below the
 * detection threshold for a tick or two while the order is still there. These
 * helpers keep `bornAt` (the wall's birth time, i.e. its "duration" anchor)
 * stable across both events.
 */

export interface InheritCandidate {
  key: string
  price: number
  /** consecutive symbol-ticks the wall has gone unseen */
  missedTicks: number
}

/**
 * Nearest candidate wall within `tolPct` relative price distance that is still
 * inside the grace window. Used to preserve `bornAt` when a wall's price
 * bucket migrates; returns the candidate's key or null.
 */
export function pickInheritCandidate(
  candidates: InheritCandidate[],
  price: number,
  tolPct: number,
  graceTicks: number,
): string | null {
  let bestKey: string | null = null
  let bestDiff = Infinity
  for (const c of candidates) {
    if (c.missedTicks > graceTicks) continue
    const lo = Math.min(c.price, price)
    if (lo <= 0) continue
    const diff = (Math.abs(c.price - price) / lo) * 100
    if (diff > tolPct) continue
    if (diff < bestDiff) {
      bestDiff = diff
      bestKey = c.key
    }
  }
  return bestKey
}
