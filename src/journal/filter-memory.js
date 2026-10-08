/**
 * The journal's filter bar, remembered across mounts and across sessions.
 *
 * Filters used to last exactly as long as the view did: saving a trade remounts
 * the journal, which dropped you back to an unfiltered table. That is fine for
 * a glance and wrong for a week spent on one model — you had to re-pick the
 * same narrowing after every single edit. So the bar is now sticky, and the
 * Clear button is the only thing that resets it.
 *
 * Sticky filters have one failure mode worth more care than the feature itself:
 * a narrowing you forgot you set looks exactly like an empty journal. Two
 * things answer that — the Clear button is visible whenever anything is active,
 * and `sanitiseFilters` drops any stored value the current vocabulary no longer
 * recognises rather than applying it.
 *
 * The account filter is *not* stored here. `accounts.js` already owns it, under
 * its own key, because restoring it needs the list of accounts that still exist
 * — and moving it would orphan what is already in localStorage.
 */

import { sanitiseFilters } from './filters.js'

const KEY = 'mazevo.filters'

/**
 * Per journal, matching the account filter's scoping: the narrowing you want on
 * the Backtest page is not the one you want on the live one, and a shared key
 * would have each page overwrite the other's on every change.
 */
const scoped = (scope) => (scope && scope !== 'live' ? `${KEY}.${scope}` : KEY)

/**
 * Reads the remembered bar. Returns a full filter set — never a partial one, so
 * callers can spread it without re-defaulting.
 *
 * Every failure path lands on "no narrowing": private browsing throws on
 * localStorage, a hand-edited value fails to parse, a stored status may no
 * longer exist. None of those should greet you with an empty table.
 */
export function rememberedFilters(scope) {
  try {
    return sanitiseFilters(JSON.parse(localStorage.getItem(scoped(scope)) || '{}'))
  } catch {
    return sanitiseFilters({})
  }
}

/** Stores the bar. `account` is dropped — accounts.js owns that one. */
export function rememberFilters(filters, scope) {
  try {
    const { account, ...rest } = sanitiseFilters(filters)
    localStorage.setItem(scoped(scope), JSON.stringify(rest))
  } catch {
    // A full quota or a private window. A forgotten preference is not worth
    // failing the interaction that caused it.
  }
}

/** Forgets the bar, so the next mount starts unfiltered. */
export function forgetFilters(scope) {
  try {
    localStorage.removeItem(scoped(scope))
  } catch {
    // As above.
  }
}
