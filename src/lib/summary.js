/**
 * A one-slot channel for the sidebar's footer totals.
 *
 * The footer needs trade counts, but the shell does not fetch — views do. The
 * alternative was a second `listTrades()` call from the shell, which would pull
 * the same 500 rows twice on every sign-in. Instead, whichever view loads
 * trades publishes the summary it already computed, and the shell renders it.
 *
 * The last value is replayed to new subscribers, so the shell showing up after
 * a view has already loaded still gets the numbers.
 */

let latest = null
const subscribers = new Set()

/** Called by any view that has just loaded trades. */
export function publishSummary(summary) {
  latest = summary
  for (const fn of subscribers) fn(latest)
}

/**
 * Calls `fn` with the current summary (if there is one) and on every later
 * publish. Returns an unsubscribe function.
 */
export function onSummary(fn) {
  subscribers.add(fn)
  if (latest) fn(latest)
  return () => subscribers.delete(fn)
}
