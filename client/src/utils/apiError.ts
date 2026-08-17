/**
 * Extract the server's `{ error }` message from an axios-style rejection.
 * err is `unknown` in TS 4.4+ — this narrows it without `as any` in callers.
 */
export function apiErrorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } } }
  return e.response?.data?.error || fallback
}