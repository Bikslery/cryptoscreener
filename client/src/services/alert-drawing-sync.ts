/**
 * Tiny pub/sub connecting the alert list and the chart drawings.
 *
 * An alert created with the bell tool is linked to its dashed ray by
 * `alertId`. When either side deletes it, the other must follow:
 * - the Уведомления list dismisses an alert → every chart removes the
 *   matching ray (emitAlertRemoved);
 * - a ray is deleted from a chart → dismissAlert is called directly.
 * This module only carries the alert→drawing direction; the reverse happens
 * through the alert store's dismissAlert.
 */

type AlertRemovedListener = (alertId: string) => void

const listeners = new Set<AlertRemovedListener>()

export function onAlertRemoved(cb: AlertRemovedListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function emitAlertRemoved(alertId: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(alertId)
    } catch { /* a listener must never break the rest */ }
  }
}
