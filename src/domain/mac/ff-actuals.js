/**
 * ISM actuals, read from the ForexFactory calendar *page*.
 *
 * `ism.js` harvests each release's `previous`, which rebuilds the whole PMI
 * history for free but is permanently one print behind — hence the manual box
 * for the current month. This module closes that last month so nothing has to
 * be typed at all.
 *
 * The weekly JSON feed cannot do it. Six fields, and an outcome is not among
 * them: title, country, date, impact, forecast, previous. The HTML calendar can
 * — it embeds the same rows in `window.calendarComponentStates`, and those
 * carry `actual` and `revision`. It also takes `?month=sep.2026`, so one
 * request covers a month and the current-week-only limit of the feed does not
 * apply here.
 *
 * That blob is a JavaScript object literal, not JSON — its keys are unquoted —
 * so only the `days` array is pulled out, which is itself valid JSON.
 *
 * Scraping a page is more brittle than reading a feed, and every step here is
 * built to fail closed: nothing is guessed, and a miss simply leaves the
 * harvested `previous` in place. A layout change upstream costs a month of lag,
 * never a wrong number.
 *
 * Pure — the page arrives as a string.
 */

import { etDate } from '../et-session.js'
import { ACTUAL_SOURCE, ISM_MANUFACTURING, parseLevel, reportedMonthOf } from './ism.js'

const MONTH_SLUGS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]

/**
 * The calendar URL for one month.
 *
 * @param {string} month `YYYY-MM`
 */
export function monthUrl(month) {
  const [year, index] = String(month).split('-').map(Number)
  const slug = MONTH_SLUGS[index - 1]
  if (!slug || !Number.isFinite(year)) throw new Error(`bad month: ${month}`)
  return `https://www.forexfactory.com/calendar?month=${slug}.${year}`
}

/**
 * The index of the `]` closing the array that opens at `open`.
 *
 * Written by hand rather than with a regex because the array contains escaped
 * quotes and nested brackets inside strings, and a regex that ignores either
 * one truncates the JSON at the first `]` in an event title.
 *
 * @returns {number} index of the closing bracket, or -1
 */
function matchBracket(text, open) {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

/**
 * The `days` array embedded in the page, or null if the page does not look the
 * way this module expects.
 *
 * Null is the honest answer for a served error page, a Cloudflare challenge, or
 * a rewritten template. The caller treats all three the same way: no harvest.
 *
 * @param {string} html
 * @returns {Array<object>|null}
 */
export function extractDays(html) {
  const text = String(html ?? '')

  const anchor = text.indexOf('window.calendarComponentStates')
  if (anchor < 0) return null

  const start = text.indexOf('days: [', anchor)
  if (start < 0) return null

  const open = start + 'days: '.length
  const end = matchBracket(text, open)
  if (end < 0) return null

  try {
    return JSON.parse(text.slice(open, end + 1))
  } catch {
    return null
  }
}

/**
 * ISM manufacturing actuals in one month's page.
 *
 * Only rows that have actually printed come back: an unreleased row carries an
 * empty `actual`, and `parseLevel` returns null for it. A forecast is never
 * substituted — that is the failure the manual box existed to prevent, and
 * automating it would be a worse version of the same mistake.
 *
 * The release is matched against the month that was requested. A page that
 * spilled a neighbouring month's rows into the grid would otherwise date a
 * print to the wrong month and quietly wreck the three-month average.
 *
 * @param {string} html the page for `month`
 * @param {{month: string}} options `YYYY-MM`, the month whose page this is
 * @returns {{entries: Array<object>, error: string|null}}
 */
export function ismActuals(html, { month }) {
  const days = extractDays(html)
  if (!days) return { entries: [], error: 'no calendar state in page' }

  const entries = []

  for (const day of days) {
    for (const event of day?.events ?? []) {
      if (event?.currency !== 'USD') continue
      if (!ISM_MANUFACTURING.test(String(event.name ?? ''))) continue

      const value = parseLevel(event.actual)
      if (value == null) continue

      const dateline = Number(event.dateline)
      if (!Number.isFinite(dateline)) continue

      // New York, because that is the timezone the release happens in and the
      // one the rest of mac dates everything by. The page renders in whatever
      // timezone the visitor's profile says, and a 4:00pm label read literally
      // would land a 10:00 ET print on the wrong side of a month boundary.
      const releaseDate = etDate(dateline * 1000)
      if (!releaseDate.startsWith(`${month}-`)) continue

      entries.push({
        date: reportedMonthOf(releaseDate),
        value,
        release_date: releaseDate,
        source: ACTUAL_SOURCE,
      })
    }
  }

  return { entries, error: null }
}

/**
 * Merges freshly scraped entries into the stored file, newest scrape winning.
 *
 * ISM revises. A month re-scraped later can legitimately carry a different
 * number than the one first published, and the later read is the better one.
 *
 * @param {Array<object>} existing
 * @param {Array<object>} scraped
 */
export function mergeActuals(existing, scraped) {
  const merged = new Map()

  for (const entry of existing ?? []) {
    if (entry?.date && Number.isFinite(entry.value)) merged.set(entry.date, { ...entry })
  }
  for (const entry of scraped ?? []) {
    if (entry?.date && Number.isFinite(entry.value)) merged.set(entry.date, { ...entry })
  }

  return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/**
 * The month whose print a given month's page carries.
 *
 * A page for October holds the release dated early October, and that release
 * reports September. Callers use it to ask "do I already have what this page
 * would give me?" before spending a request on it.
 *
 * @param {string} month `YYYY-MM` of the page
 * @returns {string} `YYYY-MM-01` of the print it carries
 */
export function reportedMonthOfPage(month) {
  const [year, index] = String(month).split('-').map(Number)
  return new Date(Date.UTC(year, index - 2, 1)).toISOString().slice(0, 10)
}

/**
 * How long into a month to wait before expecting the previous month's print.
 *
 * ISM releases on the first business day. Eight days is late enough that a
 * holiday, a weekend and a slow Action run together cannot raise a false alarm.
 */
export const GRACE_DAYS = 8

/**
 * Whether the harvest looks like it has stopped working.
 *
 * A scraper that breaks — a layout change, a persistent 403 — does not throw;
 * it simply stops finding rows, and F1 carries on with data that gets quietly
 * older. This is what makes that visible: past `GRACE_DAYS`, last month's print
 * should be on file, and if it is not the panel says so.
 *
 * @param {Array<{date: string}>} entries
 * @param {string} today `YYYY-MM-DD`
 * @returns {{stale: boolean, expected: string|null, latest: string|null}}
 */
export function harvestHealth(entries, today) {
  const latest =
    (entries ?? [])
      .map((entry) => entry?.date)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null

  const [year, month, day] = today.split('-').map(Number)

  // Too early in the month to expect it yet — nothing to judge either way.
  if (day < GRACE_DAYS) return { stale: false, expected: null, latest }

  const expected = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10)
  return { stale: latest == null || latest < expected, expected, latest }
}

/**
 * How many pages one run may ask for.
 *
 * ForexFactory answers 403 to a burst — a dozen requests back to back gets
 * every one of them refused, and it clears on its own a few minutes later. Two
 * pages per run, four runs a day, stays far under that: the current month
 * always, plus at most one month of backfill.
 *
 * Backfilling one month per run means a fresh checkout takes a day or so to
 * assemble three months of history. That is the right trade — F1 falls back to
 * a shorter average in the meantime, and the alternative is a burst that gets
 * the current month refused, which is the only one that ever matters twice.
 */
export const MAX_REQUESTS = 2

/**
 * The months worth fetching on this run.
 *
 * The current month always, because that is where an unseen print appears, and
 * then backwards over months the file has no entry for — oldest gaps last, and
 * never more than `limit` in total.
 *
 * @param {Array<object>} existing entries already stored
 * @param {string} today `YYYY-MM-DD`
 * @param {number} [depth] how many months back to consider
 * @param {number} [limit] most pages to request this run
 * @returns {Array<string>} `YYYY-MM`, newest first
 */
export function monthsToFetch(existing, today, depth = 6, limit = MAX_REQUESTS) {
  const have = new Set((existing ?? []).map((entry) => entry?.date))
  const [year, month] = today.split('-').map(Number)
  const months = []

  for (let back = 0; back < depth && months.length < limit; back += 1) {
    const release = new Date(Date.UTC(year, month - 1 - back, 1))
    const releaseMonth = release.toISOString().slice(0, 7)
    // A page for month M yields the print for M-1, so ask what M-1 is missing.
    const reports = new Date(Date.UTC(year, month - 2 - back, 1)).toISOString().slice(0, 10)

    if (back === 0 || !have.has(reports)) months.push(releaseMonth)
  }

  return months
}
