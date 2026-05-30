/**
 * Trailing-edge debounce: fires `fn` only after `ms` milliseconds
 * of silence since the last invocation.
 */
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }) as T
  return debounced
}
