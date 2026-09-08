/**
 * ISM manufacturing PMI, harvested from the ForexFactory feed.
 *
 * ISM is the one F1 input with no free API and no FRED series, and the spec
 * budgets a manual entry for it every month. The feed gets most of that back,
 * through a quirk worth stating plainly:
 *
 *   **The feed has no `actual`.** Six fields, and an outcome is not among them:
 *   title, country, date, impact, forecast, previous. A row for a release that
 *   happened three days ago still shows only what was expected.
 *
 *   **But `previous` is last month's actual.** So October's ISM row carries
 *   September's true print. Harvesting `previous` therefore rebuilds the entire
 *   ISM history for free — permanently one release behind.
 *
 * One release behind is fine for the three-month average F1 compares against,
 * which is a lagging statistic anyway. It is not fine for the current month's
 * level, which is half of F1's vote. So the manual box stays — but it is now
 * pre-filled with the forecast and framed as a confirmation, and if you skip it
 * F1 degrades to a one-month-old PMI rather than to no PMI at all.
 *
 * Everything here is pure. The feed comes in as an array; entries come out.
 */

/**
 * ISM manufacturing, and only manufacturing. FF also lists "ISM Services PMI",
 * which is a different series measuring a different economy — matching it here
 * would interleave two incompatible histories into one average.
 */
export const ISM_MANUFACTURING = /ISM Manufacturing PMI/i

/** Parses FF's `previous`/`forecast` strings, which may carry stray decoration. */
export function parseLevel(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const match = /-?\d+(\.\d+)?/.exec(String(value ?? ''))
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The month a `previous` value belongs to: the one before the release.
 *
 * ISM prints on the first business day of the month *for the month just ended*,
 * and the row's `previous` is the month before that. Dating a harvested value
 * by the release date would shift the whole history forward by two months and
 * quietly wreck the 3-month average.
 *
 * @param {string} releaseDate `YYYY-MM-DD` of the calendar row
 * @returns {string} first of the month the `previous` value describes
 */
export function previousMonthOf(releaseDate) {
  const [year, month] = releaseDate.split('-').map(Number)
  // A release on 2026-10-01 reports September and its `previous` is August.
  return new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10)
}

/**
 * ISM rows in the feed, newest first, with what each one tells us.
 *
 * @param {Array<object>} calendar
 * @returns {Array<{releaseDate: string, forecast: number|null, previous: number|null}>}
 */
export function ismRows(calendar) {
  return (Array.isArray(calendar) ? calendar : [])
    .filter((event) => event?.country === 'USD' && ISM_MANUFACTURING.test(String(event.title ?? '')))
    .map((event) => {
      const dt = new Date(event.date)
      if (!Number.isFinite(dt.getTime())) return null
      return {
        releaseDate: dt.toISOString().slice(0, 10),
        forecast: parseLevel(event.forecast),
        previous: parseLevel(event.previous),
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.releaseDate < b.releaseDate ? 1 : -1))
}

/**
 * A history entry harvested from the feed, or null when there is nothing to
 * harvest this week — which is most weeks, since ISM prints monthly.
 *
 * @param {Array<object>} calendar
 * @returns {{value: number, date: string, source: 'forexfactory'}|null}
 */
export function harvestIsm(calendar) {
  const row = ismRows(calendar)[0]
  if (!row || row.previous == null) return null

  return {
    value: row.previous,
    date: previousMonthOf(row.releaseDate),
    source: 'forexfactory',
  }
}

/**
 * What to pre-fill the manual box with, and why.
 *
 * Never returns the forecast as if it were data — the caller renders it as a
 * suggestion the trader confirms or overtypes. A forecast entered unexamined is
 * exactly the failure this whole module is meant to avoid.
 *
 * @returns {{value: number, date: string, label: string}|null}
 */
export function ismSuggestion(calendar, today) {
  const row = ismRows(calendar).find((entry) => entry.forecast != null)
  if (!row) return null

  // The month the upcoming release describes: the one before the release date.
  const [year, month] = row.releaseDate.split('-').map(Number)
  const reports = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10)

  return {
    value: row.forecast,
    date: reports,
    label:
      row.releaseDate >= today
        ? `consensus ${row.forecast} for the ${reports.slice(0, 7)} print, due ${row.releaseDate}`
        : `consensus was ${row.forecast} for ${reports.slice(0, 7)} — enter the actual`,
  }
}

/**
 * Merges harvested entries into a PMI history without disturbing hand-entered
 * ones.
 *
 * A typed value always wins over a harvested one for the same month. You typed
 * it from the release; the feed's `previous` is a secondhand echo of the same
 * number and is occasionally rounded differently. Where there is no typed
 * value, the harvest fills the gap.
 *
 * @param {Array<{date: string, value: number, source?: string}>} history
 * @param {Array<{date: string, value: number, source?: string}>} harvested
 */
export function mergeIsmHistory(history, harvested) {
  const merged = new Map()

  for (const entry of harvested ?? []) {
    if (entry?.date && Number.isFinite(entry.value)) merged.set(entry.date, { ...entry })
  }
  for (const entry of history ?? []) {
    if (!entry?.date || !Number.isFinite(entry.value)) continue
    // A manual entry has no `source`; it outranks whatever the feed said.
    merged.set(entry.date, { ...entry })
  }

  return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}
