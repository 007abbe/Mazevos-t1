/**
 * Series arithmetic for mac.
 *
 * Everything here is pure: FRED's JSON goes in, numbers come out. No fetch, no
 * clock, no key — `src/agents/reggie/mac/client.js` owns the I/O and the Edge
 * Function owns the key.
 *
 * The one non-obvious rule in this file is that N is counted in *observations*,
 * never in calendar days. "2Y change over 20 trading days" means twenty rows
 * back in a series that already omits weekends and holidays. Subtracting 20
 * days from a date and looking that up would silently reach across a long
 * weekend and compare the wrong pair — the classic way a macro backtest lies
 * about how fast a move happened.
 */

/** FRED writes a missing observation as a single dot, not null. */
const MISSING = '.'

/**
 * FRED's `/series/observations` payload as an ascending `{date, value}[]`.
 *
 * Missing observations are dropped rather than carried forward as zero: a
 * dropped row makes `n` observations back mean what it says, whereas a zero
 * would read as a real print of 0.00 and poison every delta that spans it.
 *
 * @param {object} payload the function's response for one series
 * @returns {Array<{date: string, value: number}>}
 */
export function parseObservations(payload) {
  const rows = payload?.observations
  if (!Array.isArray(rows)) return []

  return rows
    .filter((row) => row?.value !== MISSING && row?.value != null && row?.date)
    .map((row) => ({ date: String(row.date), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** The most recent observation, or null for an empty series. */
export const last = (series) => (series.length ? series[series.length - 1] : null)

/** The most recent value, or null. */
export const lastValue = (series) => last(series)?.value ?? null

/** The most recent observation date, or null. Used for staleness. */
export const lastDate = (series) => last(series)?.date ?? null

/**
 * The observation `n` rows before the latest one.
 *
 * Returns null rather than clamping to the first row when the series is too
 * short: a 20-day change computed off 6 days of history is not a 20-day change,
 * and a factor is better off reporting "no reading" than a confident wrong one.
 */
export function nBack(series, n) {
  const index = series.length - 1 - n
  return index >= 0 ? series[index] : null
}

/** Absolute change over `n` observations, or null if the history is short. */
export function changeOver(series, n) {
  const now = last(series)
  const then = nBack(series, n)
  return now && then ? now.value - then.value : null
}

/** The same change in basis points, for the rate and spread factors. */
export function changeOverBps(series, n) {
  const change = changeOver(series, n)
  return change == null ? null : change * 100
}

/** Percentage change over `n` observations, or null. */
export function pctChangeOver(series, n) {
  const now = last(series)
  const then = nBack(series, n)
  if (!now || !then || then.value === 0) return null
  return ((now.value - then.value) / then.value) * 100
}

/**
 * Mean of the last `n` values, or null if there are fewer than `n`.
 *
 * Strict on length on purpose: a "4-week moving average" computed from two
 * weeks is a different statistic wearing the same name, and F1 would compare
 * noise to noise without noticing.
 */
export function meanOfLast(series, n) {
  if (series.length < n) return null
  const window = series.slice(-n)
  return window.reduce((sum, row) => sum + row.value, 0) / n
}

/**
 * Change over `n` *calendar months*, matched by date rather than by row count.
 *
 * Monthly series (CPI, PCE) can be revised and can skip a publication, so
 * counting 12 rows back is not reliably a year. Matching the year-and-month
 * key is.
 *
 * @returns {{now: number, then: number}|null}
 */
export function monthsBackPair(series, months) {
  const now = last(series)
  if (!now) return null

  const [year, month] = now.date.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 - months, 1))
  const key = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}`

  const then = series.find((row) => row.date.startsWith(key))
  return then ? { now: now.value, then: then.value } : null
}

/** Year-over-year percentage change of a monthly index level, or null. */
export function yoy(series) {
  const pair = monthsBackPair(series, 12)
  if (!pair || pair.then === 0) return null
  return ((pair.now - pair.then) / pair.then) * 100
}

/**
 * Three-month change of a monthly index, annualised.
 *
 * `(level / level3mAgo) ^ 4 − 1`. This is the number that leads YoY at a turn:
 * YoY still carries nine months of old prints, so a re-acceleration shows up
 * here a quarter before it shows up there. F2's direction test is exactly that
 * comparison.
 */
export function annualised3m(series) {
  const pair = monthsBackPair(series, 3)
  if (!pair || pair.then <= 0) return null
  return (Math.pow(pair.now / pair.then, 4) - 1) * 100
}

/**
 * Annualised realised volatility, in percent, from `n` daily closes.
 *
 * Close-to-close log returns, sample standard deviation, √252. `n` is the
 * number of *returns*, so `n + 1` closes are required.
 */
export function realisedVol(series, n = 20) {
  if (series.length < n + 1) return null

  const closes = series.slice(-(n + 1))
  const returns = []
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1].value <= 0 || closes[i].value <= 0) return null
    returns.push(Math.log(closes[i].value / closes[i - 1].value))
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)

  return Math.sqrt(variance) * Math.sqrt(252) * 100
}

/**
 * The rolling `n`-day realised vol series, one point per day it can be computed
 * for. F7's z-score needs the distribution of rv20, not just today's value, so
 * this is what feeds its mean and standard deviation.
 */
export function realisedVolSeries(series, n = 20) {
  const out = []
  for (let end = n + 1; end <= series.length; end += 1) {
    const value = realisedVol(series.slice(0, end), n)
    if (value != null) out.push({ date: series[end - 1].date, value })
  }
  return out
}

/**
 * Z-score of the last value against the trailing `lookback` observations.
 *
 * Needs at least `minimum` points to say anything: a z-score off a handful of
 * samples is an arithmetic result, not a statistical one, and F7 would flip on
 * it.
 */
export function zScore(series, lookback = 252, minimum = 30) {
  if (series.length < minimum) return null

  const values = series.slice(-lookback).map((row) => row.value)
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  const sd = Math.sqrt(variance)

  if (!Number.isFinite(sd) || sd === 0) return null
  return (values[values.length - 1] - mean) / sd
}

/** Whole days between two `YYYY-MM-DD` dates. Negative if `to` precedes `from`. */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

/**
 * Whether a series' latest observation is older than its publication cadence
 * allows. A stale input never silently updates a factor — the factor carries
 * its previous state forward and says so in `data_health`.
 *
 * @param {Array<{date: string}>} series
 * @param {string} today `YYYY-MM-DD`
 * @param {number} budgetDays how old the latest observation may be
 */
export function isStale(series, today, budgetDays) {
  const date = lastDate(series)
  if (!date) return true

  const age = daysBetween(date, today)
  return age == null || age > budgetDays
}
