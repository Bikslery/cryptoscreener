export interface HistoryLoadPlanInput {
  cachedCount: number
  initialLimit: number
  targetLimit: number
}

/** Network depths in the order they should be requested. */
export function resolveHistoryLoadPlan(input: HistoryLoadPlanInput): number[] {
  const cachedCount = Math.max(0, input.cachedCount)
  const targetLimit = Math.max(1, input.targetLimit)
  const initialLimit = Math.min(targetLimit, Math.max(1, input.initialLimit))
  if (cachedCount >= targetLimit) return []
  if (cachedCount >= initialLimit || initialLimit === targetLimit) return [targetLimit]
  return [initialLimit, targetLimit]
}
