/**
 * Client-side filter and sort for the journal table.
 *
 * Nothing here queries. It narrows the array `listTrades` already returned,
 * which is the constraint that decides what can be filtered on: every field
 * read below has to be in `LIST_COLUMNS`. `thesis` is there for the search box;
 * `hindsight` is not, so — unlike FlowJournal, which matches both
 * (trading-journal/index.html:2219) — search does not reach it.
 *
 * Pure, so the combining rules are testable without a DOM.
 */

/** Options for the sort dropdown, in display order. */
export const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'pnl-high', label: 'P&L high to low' },
  { value: 'pnl-low', label: 'P&L low to high' },
]

export const STATUSES = ['TP', 'SL', 'BE', 'TP1+BE', 'Open']
export const DIRECTIONS = ['Long', 'Short']

/**
 * The account dropdown's value for "trades with no account", as distinct from
 * '' which means "every account". A sentinel rather than null because the value
 * round-trips through a `<select>`, where everything is a string — and every
 * trade logged before accounts existed is unassigned, so this is a real view of
 * the data, not an edge case.
 */
export const UNASSIGNED = 'none'

/** Empty filter state — every field falsy means "no narrowing". */
export const NO_FILTERS = { search: '', status: '', direction: '', account: '', sort: 'newest' }

/**
 * Narrows to one account. Separate from `applyFilters` because the header tiles
 * and the sidebar totals apply *only* this one: picking an account changes what
 * "Net P&L" means, while typing in the search box must not — otherwise the tiles
 * would re-read as stats-for-my-search, which is not a number anyone wants.
 */
export function byAccount(trades, account) {
  if (!account) return trades
  if (account === UNASSIGNED) return trades.filter((t) => !t.account_id)
  return trades.filter((t) => t.account_id === account)
}

/**
 * The label the table shows for a trade. There is no ticker column on the
 * table; FlowJournal composes this from `num` at render time
 * (trading-journal/index.html:2249), so searching "NQ #46" has to match here.
 */
export const tradeLabel = (t) => `NQ #${t.num ?? '?'}`

/**
 * `date` is a text column holding `YYYY-MM-DDTHH:mm`, so string order is
 * chronological order. Comparing as strings avoids constructing 500 Dates per
 * keystroke, and avoids `new Date(undefined)` producing NaN on a null date.
 */
const byDateAsc = (a, b) => String(a.date ?? '').localeCompare(String(b.date ?? ''))

const num = (v) => Number(v ?? 0)

const COMPARATORS = {
  newest: (a, b) => byDateAsc(b, a),
  oldest: byDateAsc,
  'pnl-high': (a, b) => num(b.pnl) - num(a.pnl),
  'pnl-low': (a, b) => num(a.pnl) - num(b.pnl),
}

function matchesSearch(trade, needle) {
  const haystack = `${tradeLabel(trade)} ${trade.thesis ?? ''}`.toLowerCase()
  return haystack.includes(needle)
}

/**
 * Applies every active filter, then sorts. Filters combine — each one narrows
 * what the previous left, so an empty result means the combination matched
 * nothing, not that one filter failed.
 *
 * @param {object[]} trades rows from `listTrades`
 * @param {object} filters partial; anything omitted falls back to `NO_FILTERS`
 * @returns {object[]} a new array; the input is not mutated
 */
export function applyFilters(trades, filters = {}) {
  const { search, status, direction, account, sort } = { ...NO_FILTERS, ...filters }
  const needle = search.trim().toLowerCase()

  const filtered = byAccount(trades, account).filter((t) => {
    if (status && t.status !== status) return false
    if (direction && t.type !== direction) return false
    if (needle && !matchesSearch(t, needle)) return false
    return true
  })

  // sort() mutates, so this sorts the copy filter() just produced.
  return filtered.sort(COMPARATORS[sort] ?? COMPARATORS.newest)
}
