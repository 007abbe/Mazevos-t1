/**
 * Downloading every vintage of a FRED series, once, to disk.
 *
 * The naive way to replay mac is to ask the `mac-fred` function for an `as_of`
 * snapshot per session. That is eighteen series times four thousand sessions —
 * seventy thousand requests — and it would take days and hammer FRED for data
 * that never changes once it is past.
 *
 * ALFRED answers the whole thing in one request per series. Setting the realtime
 * bounds wide returns one row per *(observation date, vintage)* pair, each
 * carrying the window during which it was the published value. That is the
 * complete revision history, and every as-of view is a local filter over it —
 * see `src/domain/mac/vintage.js`.
 *
 * The Edge Function is bypassed on purpose. It exists to keep the API key out of
 * the browser, and it caps `observation_start` to a rolling window measured from
 * today — correct for the daily snapshot, useless for a replay that starts in
 * 2012. A terminal script has the key in its own environment and no such cap.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'

const FRED = 'https://api.stlouisfed.org/fred/series/observations'

/** FRED's hard ceiling on rows per request. */
const PAGE = 100000

export const CACHE_DIR = 'backtest/vintages'

/** Every series mac reads, straight from the factor definitions. */
export const seriesIds = (SERIES) => Object.values(SERIES).map((s) => s.id)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The day after an observation, as its publication date.
 *
 * Used only by the unrevised path below. FRED publishes daily market and rate
 * series the following business day, and `asOfSeries` separately refuses
 * anything dated the replay session itself, so the two agree: as of morning D,
 * the newest close available is D-1.
 */
const dayAfter = (date) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)

/**
 * A series that is published once and never restated.
 *
 * FRED refuses an all-vintages request spanning more than a couple of thousand
 * vintage dates, and a daily series stamps a new vintage every business day —
 * DFEDTARU alone has 3,773 since 2008. Chunking the realtime window would work
 * but is pointless: `output_type=2` returns every observation *for every
 * vintage*, so the full history of a daily series is millions of rows
 * describing values that never changed.
 *
 * So these are fetched as a plain series and given a synthetic one-day
 * publication lag. For a series with a single vintage that is not an
 * approximation — first print is the only print, and the lag is the only thing
 * the replay needed from ALFRED in the first place.
 *
 * The list is not guessed per-series: this is the fallback for anything FRED
 * refuses to give vintages for, and which series took which path is printed on
 * every run rather than assumed.
 */
async function fetchUnrevised(id, key, observationStart) {
  const url = new URL(FRED)
  url.searchParams.set('series_id', id)
  url.searchParams.set('api_key', key)
  url.searchParams.set('file_type', 'json')
  url.searchParams.set('observation_start', observationStart)
  url.searchParams.set('limit', String(PAGE))

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${id}: FRED ${res.status} ${(await res.text()).slice(0, 200)}`)
  }

  const body = await res.json()
  return (body?.observations ?? []).map((o) => ({
    date: o.date,
    value: o.value,
    realtime_start: dayAfter(o.date),
    realtime_end: '9999-12-31',
  }))
}

/** FRED's complaint when the realtime window spans too many vintage dates. */
const TOO_MANY_VINTAGES = /exceeds the max/i

/**
 * Series that are published once and never restated.
 *
 * For these the synthetic next-day lag is exact, not an approximation: a market
 * close, a constant-maturity yield, a policy rate and an index spread are all
 * printed once and never revised, so "the first vintage" and "the only vintage"
 * are the same thing.
 *
 * They are listed rather than detected because ALFRED's coverage is a poor
 * detector. It holds vintages for BAMLH0A0HYM2 only from September 2023 and for
 * NASDAQ100 only from May 2014 — not because those series were revised before
 * then, but because ALFRED simply did not track them. Trusting that would hand
 * the replay a three-year credit series and call it complete, which is a
 * dressed-up version of the bug that already cost one result.
 *
 * Everything *not* on this list is genuinely restated — a claims number revised
 * the following week, a CPI print revised with new seasonal factors, a GDPNow
 * nowcast revised twice a week — and for those the synthetic lag would be a
 * serious leak. A monthly CPI observation dated the 1st is not published until
 * the middle of the next month; giving it a one-day lag would hand mac six
 * weeks of future inflation data. So those come from real vintages or the
 * replay does not cover them.
 */
export const UNREVISED = new Set([
  'DFEDTARU',
  'DGS2',
  'DGS10',
  'DFII10',
  'RRPONTSYD',
  'BAMLH0A0HYM2',
  'BAMLC0A0CM',
  'DTWEXBGS',
  'DEXJPUS',
  'VIXCLS',
  'VXVCLS',
  'NASDAQ100',
])

/**
 * All vintages of one series.
 *
 * Paginated because a heavily revised series runs past FRED's row ceiling —
 * GDPNow alone is revised several times a week for a decade. A truncated series
 * would not error; it would silently start in the middle, and the replay would
 * report a confident result over a shorter window than it claims.
 *
 * @returns {Promise<{rows: Array<{date: string, value: string,
 *   realtime_start: string, realtime_end: string}>, revised: boolean}>}
 */
export async function fetchVintages(id, key, { observationStart = '2005-01-01' } = {}) {
  // Never revised: the plain series with a next-day lag is both complete and
  // exact, and ALFRED's partial vintage record for these would only truncate it.
  if (UNREVISED.has(id)) {
    return { rows: await fetchUnrevised(id, key, observationStart), revised: false }
  }

  const rows = []

  // Walk the realtime axis in slices. A single wide request looks like it
  // works and does not: FRED answers with only the most recent few hundred
  // vintage dates, which for a daily-revised series silently drops every
  // observation older than about three years. Nothing in the response says so —
  // the first version of this file was caught by exactly that, and the backtest
  // it produced was measuring a model running half-blind.
  for (const [start, end] of realtimeSlices(observationStart)) {
    for (let offset = 0; ; offset += PAGE) {
      const url = new URL(FRED)
      url.searchParams.set('series_id', id)
      url.searchParams.set('api_key', key)
      url.searchParams.set('file_type', 'json')
      url.searchParams.set('observation_start', observationStart)
      url.searchParams.set('realtime_start', start)
      url.searchParams.set('realtime_end', end)
      url.searchParams.set('limit', String(PAGE))
      url.searchParams.set('offset', String(offset))

      const res = await fetch(url)

      if (!res.ok) {
        const detail = await res.text()

        // The series did not exist yet in this slice, or has no ALFRED record
        // at all. Neither is an error; both mean this slice contributes nothing.
        if (/No vintage dates exist|does not exist in ALFRED/i.test(detail)) break

        // Still too many vintages even for a slice: the series stamps a new
        // one every day, which means it is never actually restated. Fall back
        // to the plain series with a publication lag.
        if (TOO_MANY_VINTAGES.test(detail)) {
          return { rows: await fetchUnrevised(id, key, observationStart), revised: false }
        }

        throw new Error(`${id}: FRED ${res.status} ${detail.slice(0, 200)}`)
      }

      const body = await res.json()
      const page = body?.observations ?? []

      rows.push(
        ...page.map((o) => ({
          date: o.date,
          value: o.value,
          realtime_start: o.realtime_start,
          realtime_end: o.realtime_end,
        }))
      )

      if (page.length < PAGE) break
      await wait(300)
    }

    await wait(200)
  }

  // Every slice declined. The series has no ALFRED record at all, so it has no
  // revisions to reconstruct — take the plain observations with a publication
  // lag rather than returning an empty series, which is the one outcome that
  // would sail silently through into the replay.
  if (!rows.length) {
    return { rows: await fetchUnrevised(id, key, observationStart), revised: false }
  }

  return { rows: dedupe(rows), revised: true }
}

/**
 * Two-year realtime windows from `start` to today.
 *
 * Two years keeps a daily-revised series under FRED's per-request vintage
 * ceiling with room to spare. A slice that returns nothing is skipped, so
 * starting earlier than a series exists costs one cheap request.
 */
function realtimeSlices(start, years = 2) {
  const slices = []
  let from = new Date(Date.parse(`${start}T00:00:00Z`))

  // FRED rejects a `realtime_end` in the future outright, so the last slice
  // stops at today rather than running past it.
  const today = new Date().toISOString().slice(0, 10)

  while (from.toISOString().slice(0, 10) < today) {
    const to = new Date(from)
    to.setUTCFullYear(to.getUTCFullYear() + years)

    const end = to.toISOString().slice(0, 10)
    slices.push([from.toISOString().slice(0, 10), end < today ? end : today])
    from = to
  }

  return slices
}

/**
 * One row per (observation, value), with its true validity window.
 *
 * FRED clips *both* realtime bounds to the requested window, and the same
 * observation therefore comes back once per slice it survives into, each copy
 * claiming a validity that stops at that slice's edge. Merging has to widen the
 * window from every copy — earliest start, latest end — or the reconstruction
 * silently loses old observations.
 *
 * The first version of this only fixed `realtime_start`. Every unrevised
 * observation then carried a `realtime_end` clipped to the slice that first
 * published it, so `asOfSeries` dropped it for any later date and each series
 * collapsed to roughly its current two-year slice. WALCL as of mid-2015 came
 * back with 24 rows instead of 650, and the factors that read it were computing
 * on a stub. Nothing errored; the numbers just quietly meant nothing.
 */
function dedupe(rows) {
  const best = new Map()

  for (const row of rows) {
    const key = `${row.date}|${row.value}`
    const held = best.get(key)

    if (!held) {
      best.set(key, { ...row })
      continue
    }

    if (row.realtime_start < held.realtime_start) held.realtime_start = row.realtime_start
    if (row.realtime_end > held.realtime_end) held.realtime_end = row.realtime_end
  }

  return [...best.values()].sort((a, b) =>
    a.date === b.date
      ? a.realtime_start < b.realtime_start
        ? -1
        : 1
      : a.date < b.date
        ? -1
        : 1
  )
}

/**
 * All vintages of every series, from disk where possible.
 *
 * The cache is the point: a replay gets run many times while the report is being
 * read, and re-downloading a decade of revision history each time would make
 * iterating on the analysis slower than writing it.
 *
 * @param {Array<string>} ids
 * @param {string} key FRED API key
 * @param {(msg: string) => void} [log]
 */
export async function loadStore(ids, key, log = () => {}, options = {}) {
  await mkdir(CACHE_DIR, { recursive: true })
  const store = {}

  const provenance = {}

  for (const id of ids) {
    const path = `${CACHE_DIR}/${id}.json`

    try {
      const cached = JSON.parse(await readFile(path, 'utf8'))
      store[id] = cached.rows
      provenance[id] = cached.revised
      log(`${id}: ${cached.rows.length} rows (cached, ${cached.revised ? 'vintages' : 'single-vintage'})`)
      continue
    } catch {
      // Not cached yet — fall through and fetch it.
    }

    if (!key) throw new Error(`${id} is not cached and no FRED_API_KEY is set`)

    const { rows, revised } = await fetchVintages(id, key, options)
    await writeFile(path, JSON.stringify({ revised, rows }))
    store[id] = rows
    provenance[id] = revised
    log(`${id}: ${rows.length} rows (fetched, ${revised ? 'vintages' : 'single-vintage'})`)
  }

  return { store, provenance }
}
