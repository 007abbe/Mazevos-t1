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

import { tradeKind } from '../domain/veto-vocab.js'

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

/**
 * Which journal a trade belongs to. Not a filter the user picks from a
 * dropdown — it is which page they are on, and it is applied before everything
 * else so the two journals can never show each other's rows.
 */
export const SCOPES = { LIVE: 'live', BACKTEST: 'backtest' }

/** Empty filter state — every field falsy means "no narrowing". */
export const NO_FILTERS = {
  search: '',
  status: '',
  direction: '',
  account: '',
  // '' is both kinds. Not defaulted to 'trade': a veto you cannot see is a veto
  // you stop logging.
  kind: '',
  sort: 'newest',
}

/**
 * Splits the loaded trades into the journal being viewed.
 *
 * The partition is total and has no overlap: a trade on a Backtest account is
 * the Backtest journal's, everything else — including every unassigned trade,
 * which is what all 57 pre-accounts rows are — is the live journal's. That
 * asymmetry is on purpose. An unassigned trade was taken on *something real*
 * that simply was not recorded; defaulting it into the backtest would quietly
 * erase P&L from the live tiles.
 *
 * @param {Set<string>} backtestIds from `backtestAccountIds(accounts)`
 */
export function byScope(trades, scope, backtestIds) {
  const isBacktest = (t) => !!t.account_id && backtestIds.has(t.account_id)
  return scope === SCOPES.BACKTEST ? trades.filter(isBacktest) : trades.filter((t) => !isBacktest(t))
}

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
  const { search, status, direction, account, kind, sort } = { ...NO_FILTERS, ...filters }
  const needle = search.trim().toLowerCase()

  const filtered = byAccount(trades, account).filter((t) => {
    // Before status, because a veto has none — it was never filled, so TP/SL is
    // not a question it can answer. Checking status first would let "All
    // statuses" quietly behave differently from every named status.
    if (kind && tradeKind(t) !== kind) return false
    if (status && t.status !== status) return false
    if (direction && t.type !== direction) return false
    if (needle && !matchesSearch(t, needle)) return false
    return true
  })

  // sort() mutates, so this sorts the copy filter() just produced.
  return filtered.sort(COMPARATORS[sort] ?? COMPARATORS.newest)
}
