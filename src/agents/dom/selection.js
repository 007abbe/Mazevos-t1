/**
 * Trade selection for DOM.
 *
 * Deliberately local time, unlike Finski. Finski reasons about the US market
 * day and standardises on ET; DOM reasons about *your logging* — and the `date`
 * column is `YYYY-MM-DDTHH:mm` wall-clock text written by a `datetime-local`
 * input, i.e. already in your zone. Comparing it in ET would bucket an
 * evening-logged trade into the wrong day.
 *
 * Because the stored value is local wall clock, string comparison on the date
 * part is exact — no parsing, no offsets.
 */

/** `YYYY-MM-DD` for an epoch ms instant, in the browser's own zone. */
export function localDate(now) {
  return new Date(now).toLocaleDateString('sv-SE')
}

/** The date part of a trade's timestamp, or null if it has none. */
const dateOf = (trade) => (trade.date ? trade.date.slice(0, 10) : null)

/** `YYYY-MM-DD` of the Monday on or before `now`. */
export function weekStart(now) {
  const monday = new Date(now)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)) // Monday = 0
  monday.setHours(0, 0, 0, 0)
  return localDate(monday.getTime())
}

export function selectToday(trades, now) {
  const today = localDate(now)
  return trades.filter((t) => dateOf(t) === today)
}

/**
 * Monday to now. There is no upper bound, matching FlowJournal: a trade dated
 * ahead of today still counts as this week's.
 */
export function selectThisWeek(trades, now) {
  const monday = weekStart(now)
  return trades.filter((t) => dateOf(t) !== null && dateOf(t) >= monday)
}

/**
 * Human-readable scope, stored on the report row so history stays meaningful.
 * FlowJournal stored only "12 trades"; the date range costs nothing and answers
 * the first question you ask of an old report.
 */
export function describeScope(trades) {
  const count = `${trades.length} ${trades.length === 1 ? 'trade' : 'trades'}`
  const dates = trades.map(dateOf).filter(Boolean).sort()
  if (!dates.length) return count

  const first = dates[0]
  const last = dates[dates.length - 1]
  return first === last ? `${count} · ${first}` : `${count} · ${first} → ${last}`
}
