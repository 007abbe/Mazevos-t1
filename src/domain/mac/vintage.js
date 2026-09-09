/**
 * Point-in-time reconstruction: what FRED said on a given day.
 *
 * The replay's whole credibility rests on this file. mac's factors are a pure
 * function of the series handed to them, so a replay is only honest if those
 * series contain exactly what was published at the time — no later revision, no
 * observation that had not yet been released.
 *
 * ALFRED gives us the raw material. Asking FRED for a series across all realtime
 * bounds returns one row per *(observation date, vintage)* pair, each stamped
 * with the window `[realtime_start, realtime_end]` during which that was the
 * published value. Reconstructing a day is then a filter: keep the rows whose
 * window contains it, and where an observation has several, keep the one that
 * was current.
 *
 * Two failure modes this exists to prevent, both of which make a backtest look
 * better than the strategy:
 *
 *   **Revision leakage.** GDPNow is revised continuously and core PCE is
 *   revised for years. Reading the final value on a date it had not yet
 *   settled to lets the model see the answer.
 *
 *   **Release leakage.** A monthly print for August is stamped with observation
 *   date August 1st but is not published until the first week of September.
 *   Filtering on the observation date alone would hand mac the August CPI all
 *   through August.
 *
 * There is a third guard that ALFRED cannot provide, and `asOfSeries` applies it
 * unconditionally: **an observation dated on the replay day itself is dropped.**
 * mac runs pre-market, before any of that session's closes exist. FRED stamps
 * some daily series as available the same day, so trusting the realtime bounds
 * alone would let the replay read Monday's VIX close on Monday morning — which
 * is a small leak that points the right way on exactly the days that matter.
 *
 * Everything here is pure: ALFRED rows in, mac-shaped series out.
 */

/** FRED writes a missing observation as a single dot, not null. */
const MISSING = '.'

/**
 * The series as it stood on `asOf`, in the `{date, value}[]` shape mac's
 * factors expect.
 *
 * @param {Array<{date: string, value: string|number, realtime_start: string,
 *   realtime_end: string}>} rows every vintage of one series
 * @param {string} asOf `YYYY-MM-DD`
 * @returns {Array<{date: string, value: number}>} ascending by observation date
 */
export function asOfSeries(rows, asOf) {
  const current = new Map()

  for (const row of rows ?? []) {
    if (!row?.date || !row.realtime_start) continue

    // Pre-market: today's own observation does not exist yet, whatever the
    // realtime stamp claims. See the note at the top of the file.
    if (row.date >= asOf) continue

    // The vintage window. `realtime_end` of 9999-12-31 means "still current".
    if (row.realtime_start > asOf) continue
    if (row.realtime_end && row.realtime_end < asOf) continue

    if (row.value === MISSING || row.value == null) continue
    const value = Number(row.value)
    if (!Number.isFinite(value)) continue

    // Several vintages can satisfy the window if `realtime_end` is missing from
    // the payload; the later `realtime_start` is the later revision.
    const held = current.get(row.date)
    if (held && held.realtime_start > row.realtime_start) continue

    current.set(row.date, { value, realtime_start: row.realtime_start })
  }

  return [...current.entries()]
    .map(([date, { value }]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * Builds every series for one day, keyed the way `buildSnapshot` wants them.
 *
 * @param {Record<string, Array<object>>} store series id → all vintages
 * @param {string} asOf `YYYY-MM-DD`
 * @returns {Record<string, Array<{date: string, value: number}>>}
 */
export function seriesAsOf(store, asOf) {
  const out = {}
  for (const [id, rows] of Object.entries(store ?? {})) out[id] = asOfSeries(rows, asOf)
  return out
}

/**
 * The dates a replay should step through: every date on which the index
 * actually traded.
 *
 * Taken from the NDX series rather than from a calendar, because that is the
 * definition that matters — a session mac scored but on which nothing traded
 * contributes no return, and a holiday invented by a date loop would quietly
 * dilute every average.
 *
 * @param {Array<object>} ndxRows all vintages of the NDX series
 * @param {string} from `YYYY-MM-DD`
 * @param {string} to `YYYY-MM-DD`
 */
export function sessionDates(ndxRows, from, to) {
  const dates = new Set()

  for (const row of ndxRows ?? []) {
    if (!row?.date || row.value === MISSING || row.value == null) continue
    if (row.date < from || row.date > to) continue
    dates.add(row.date)
  }

  return [...dates].sort()
}

/**
 * Closing levels by date, from the final (revised) vintage.
 *
 * Deliberately *not* point-in-time. This is the outcome being measured, not an
 * input to the decision — mac never sees it. An index close is not revised in
 * any case, but the distinction matters: the moment scoring reads through the
 * same as-of filter as the inputs, a publication lag would silently shift every
 * return by a day and the backtest would be measuring the wrong session.
 *
 * @param {Array<object>} ndxRows
 * @returns {Map<string, number>}
 */
export function closesByDate(ndxRows) {
  const closes = new Map()

  for (const row of ndxRows ?? []) {
    if (!row?.date || row.value === MISSING || row.value == null) continue
    const value = Number(row.value)
    if (!Number.isFinite(value)) continue

    // Later vintages overwrite earlier ones, leaving the final value.
    const held = closes.get(row.date)
    if (held && held.realtime_start > row.realtime_start) continue
    closes.set(row.date, { value, realtime_start: row.realtime_start })
  }

  return new Map([...closes].map(([date, { value }]) => [date, value]))
}
