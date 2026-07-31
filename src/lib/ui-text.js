/**
 * Text helpers shared by every view.
 *
 * These were copied verbatim into each UI module. Escaping in particular is
 * not something to keep five copies of — a fix in one would silently not be a
 * fix in the others.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

/** Escapes text for interpolation into an HTML template string. */
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ENTITIES[c])

/**
 * An expired session reads as a generic failure otherwise, and the fix is
 * specific: sign out and back in. Everything the Edge Functions and Supabase
 * emit for that case is matched here.
 */
const SESSION_EXPIRED = /sign in required|jwt|401|unauthor|not signed in/i

/**
 * Turns an error into something that tells the trader what to do about it.
 *
 * @param {unknown} error
 * @param {object} options
 * @param {string} options.prefix leading text for unrecognised failures
 * @param {RegExp[]} [options.passThrough] messages already actionable enough to
 *   show as-is — the calendar's "run the Action, then retry", for instance
 */
export function explainFailure(error, { prefix = 'Failed', passThrough = [] } = {}) {
  const message = error?.message ?? String(error)

  if (SESSION_EXPIRED.test(message)) {
    return 'Session expired — sign out and back in, then retry.'
  }
  if (passThrough.some((pattern) => pattern.test(message))) return message

  return `${prefix}: ${message}`
}
