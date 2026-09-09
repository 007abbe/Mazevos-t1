/**
 * ISM manufacturing PMI: what a history entry means, and how three sources are
 * reconciled into one.
 *
 * ISM is the one F1 input with no free API and no FRED series — FRED's NAPM
 * series was discontinued in 2016 when ISM withdrew redistribution — so it is
 * assembled rather than fetched. Three sources, in the order they arrive:
 *
 *   **The weekly feed's `previous`** — harvested here. The feed has no
 *   `actual`: six fields, and an outcome is not among them. But `previous` on
 *   an ISM row is last month's true print, so October's row carries September's
 *   number. That rebuilds the whole history for free, permanently one release
 *   behind.
 *
 *   **The calendar page's `actual`** — scraped by the Action, parsed in
 *   `ff-actuals.js`. The page carries the field the feed omits, so the current
 *   month's print lands within hours of release. This is what removed the
 *   monthly manual entry.
 *
 *   **A typed entry** — still available, now as an override rather than a
 *   chore. It outranks both.
 *
 * `mergeIsmHistory` is where those three meet, and the ranking there is the
 * single place that decides which one wins.
 *
 * Everything here is pure. The feed comes in as an array; entries come out.
 */

/**
 * ISM manufacturing, and only manufacturing. FF also lists "ISM Services PMI",
 * which is a different series measuring a different economy — matching it here
 * would interleave two incompatible histories into one average.
 */
export const ISM_MANUFACTURING = /ISM Manufacturing PMI/i

/**
 * Source tags. Defined here rather than beside the code that produces them, so
 * the ranking below can be read without opening another file — and so `ism.js`
 * stays the module that owns what a PMI history entry means.
 */
export const PREVIOUS_SOURCE = 'forexfactory'
export const ACTUAL_SOURCE = 'forexfactory-actual'

/** Parses FF's `previous`/`forecast` strings, which may carry stray decoration. */
export function parseLevel(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const match = /-?\d+(\.\d+)?/.exec(String(value ?? ''))
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The month a release *reports*: the one just ended.
 *
 * ISM prints on the first business day of the month for the month before it, so
 * the release dated 2026-09-01 is the August number. Dating a print by its
 * release date would shift the whole history forward a month and quietly wreck
 * the 3-month average.
 *
 * @param {string} releaseDate `YYYY-MM-DD` of the calendar row
 * @returns {string} first of the month the `actual` describes
 */
export function reportedMonthOf(releaseDate) {
  const [year, month] = releaseDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10)
}

/**
 * The month a `previous` value belongs to: one before the reported month.
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
    source: PREVIOUS_SOURCE,
  }
}

/**
 * How much a value for a given month is trusted when two sources disagree.
 *
 * Three tiers, and the ordering is the whole point:
 *
 *   **typed** — you read it off the release. Nothing outranks that, which is
 *   what keeps the manual box meaningful as an override once it stops being a
 *   chore. Stored history from before the scraper carries no `source` and lands
 *   here, so nothing already entered is ever demoted by an automated read.
 *
 *   **actual** — scraped from the calendar page's `actual`. The real print,
 *   available the day it happens.
 *
 *   **previous** — the next release's `previous` field. The same number seen
 *   secondhand a month later, and occasionally rounded differently, so it only
 *   fills months the better two never reached.
 */
const SOURCE_RANK = { [PREVIOUS_SOURCE]: 1, [ACTUAL_SOURCE]: 2 }
const rankOf = (entry) => SOURCE_RANK[entry?.source] ?? 3

/**
 * Merges entries into a PMI history, best source per month winning.
 *
 * @param {Array<{date: string, value: number, source?: string}>} history
 * @param {...Array<{date: string, value: number, source?: string}>} incoming
 */
export function mergeIsmHistory(history, ...incoming) {
  const merged = new Map()

  for (const entry of [...(history ?? []), ...incoming.flat()]) {
    if (!entry?.date || !Number.isFinite(entry.value)) continue

    const held = merged.get(entry.date)
    // Rank decides first; a tie goes to the later argument. Callers pass the
    // stored history first and the freshest read last, so a re-typed value
    // replaces the one it corrects and a revised print replaces the original —
    // without either one being able to displace a stronger source.
    if (held && rankOf(held) > rankOf(entry)) continue

    merged.set(entry.date, { ...entry })
  }

  return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}
