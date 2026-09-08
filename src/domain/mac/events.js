/**
 * L2: what kind of day today is, and what that costs you.
 *
 * Inputs are the ForexFactory weekly feed Finski already fetches, plus the vol
 * regime from F7. No new source, no new table, no Sunday data entry.
 *
 * The feed's hard limit shapes this whole module: **it only ever contains the
 * current week.** `nextweek`, `lastweek`, `today` and the monthly variants all
 * 404. So the event horizon runs out on Friday no matter what — on Monday it
 * sees five sessions, by Thursday two. Rather than quietly returning a short
 * list that reads like "nothing scheduled", every result carries
 * `horizon_sessions` and `horizon_ends`, and the caller says so out loud. A
 * five-session watch list that silently became a two-session one is worse than
 * no watch list, because it looks like an all-clear.
 *
 * Event tiers reuse the regexes in `model-risk.js` rather than restating them.
 * Finski's HIGH model-risk and mac's `tier1_event` must mean the same thing on
 * the same day; two copies of "what counts as CPI" would eventually disagree.
 */

import { FOMC, MAJOR_RELEASE, SECOND_TIER_INFLATION } from '../model-risk.js'
import { etDate, nySessionWindow, timeET, timeLabel } from '../et-session.js'

/**
 * Second-tier scheduled movers beyond the inflation prints. These reprice the
 * tape without repricing the curve — worth a size cap, not a stand-aside.
 */
export const TIER2_OTHER =
  /ISM (Manufacturing|Services)|Retail Sales|Consumer Confidence|Michigan|JOLTS|ADP|Unemployment Claims|GDP/i

/** Treasury supply. FF titles these "10-y Bond Auction", "30-y Bond Auction". */
export const AUCTION = /\b(10|20|30)-y(ear)?\s+(Bond|Note)\s+Auction/i

/** Minutes after a Tier 1 print during which the tape is unreadable. */
export const TIER1_BLACKOUT_MIN = 5

/** The FOMC statement window, in ET minutes past midnight. */
export const FOMC_WINDOW = { from: 14 * 60, to: 14 * 60 + 15 }

export const SIZE_CAP = { tier1: 0.5, tier2: 0.75, normal: 1 }

/**
 * The tier of one event, or null if it is not one mac cares about.
 *
 * Only USD High/Medium reach here — a High-impact print in another currency
 * moves that currency's tape, not NQ's multiple.
 */
export function tierOf(event) {
  if (event?.country !== 'USD') return null
  if (event.impact !== 'High' && event.impact !== 'Medium') return null

  const title = String(event.title ?? '')

  if (event.impact === 'High' && (MAJOR_RELEASE.test(title) || FOMC.test(title))) return 1
  if (SECOND_TIER_INFLATION.test(title) || TIER2_OTHER.test(title)) return 2

  return null
}

export const isAuction = (event) =>
  event?.country === 'USD' && AUCTION.test(String(event?.title ?? ''))

/* ------------------------------------------------------- calendar shape ---- */

const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay()

const isWeekday = (date) => {
  const day = weekdayOf(date)
  return day >= 1 && day <= 5
}

const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

/**
 * The next `count` trading sessions starting at `from` inclusive.
 *
 * Weekends only — market holidays are not in the feed and inventing a holiday
 * calendar to shave one day off a watch horizon is not worth the ways it could
 * be wrong.
 */
export function sessionsFrom(from, count) {
  const out = []
  let date = from

  while (out.length < count) {
    if (isWeekday(date)) out.push(date)
    date = addDays(date, 1)
  }

  return out
}

/** Third Friday of the month containing `date` — index expiry. */
export function opexDate(date) {
  const [year, month] = date.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 1, 1))
  // 5 = Friday. Days to the first Friday, then two more weeks.
  const offset = (5 - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month - 1, 1 + offset + 14)).toISOString().slice(0, 10)
}

/** Last weekday of the month containing `date`. */
export function monthEnd(date) {
  const [year, month] = date.split('-').map(Number)
  let last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  while (!isWeekday(last)) last = addDays(last, -1)
  return last
}

const QUARTER_MONTHS = [3, 6, 9, 12]

/**
 * The date flags that need no feed at all — they are arithmetic.
 *
 * Roll week is the five sessions before quarterly expiry, which is when NQ
 * volume migrates to the next contract and the front month's tape thins out.
 */
export function dateFlags(date) {
  const month = Number(date.split('-')[1])
  const quarterly = QUARTER_MONTHS.includes(month)
  const opex = opexDate(date)
  const rollWindow = sessionsFrom(addDays(opex, -7), 5)

  return {
    opex: date === opex,
    month_end: date === monthEnd(date),
    quarter_end: quarterly && date === monthEnd(date),
    roll_week: quarterly && rollWindow.includes(date),
  }
}

/* ------------------------------------------------------------- day type ---- */

/**
 * Today's events, in New York terms, with their tier attached.
 *
 * @param {Array<object>} calendar the full weekly feed
 * @param {string} date `YYYY-MM-DD` in ET
 */
export function eventsOn(calendar, date) {
  return (Array.isArray(calendar) ? calendar : [])
    .map((event) => ({ ...event, dt: new Date(event.date) }))
    .filter((event) => Number.isFinite(event.dt.getTime()) && etDate(event.dt.getTime()) === date)
    .map((event) => ({ ...event, tier: tierOf(event), auction: isAuction(event) }))
    .filter((event) => event.tier != null || event.auction)
    .sort((a, b) => a.dt - b.dt)
}

/**
 * Windows during which nothing should be entered.
 *
 * A Tier 1 print blacks out the five minutes after it lands; the FOMC statement
 * blacks out 14:00–14:15 ET regardless of when the calendar row is timed,
 * because the move starts on the statement and not on whatever minute the feed
 * recorded.
 */
export function noTradeWindows(events, date) {
  const windows = []

  for (const event of events) {
    if (event.tier !== 1) continue

    if (FOMC.test(String(event.title))) {
      windows.push({
        from: minutesToET(FOMC_WINDOW.from),
        to: minutesToET(FOMC_WINDOW.to),
        why: `${event.title} — statement window`,
      })
      continue
    }

    const release = event.dt.getTime()
    windows.push({
      from: timeET(event.dt),
      to: timeET(new Date(release + TIER1_BLACKOUT_MIN * 60000)),
      why: `${event.title} — release`,
    })
  }

  return dedupeWindows(windows)
}

const minutesToET = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** Two Tier 1 prints at 08:30 produce one window, not two identical ones. */
function dedupeWindows(windows) {
  const seen = new Map()
  for (const window of windows) {
    const key = `${window.from}-${window.to}`
    if (seen.has(key)) seen.get(key).why += `; ${window.why}`
    else seen.set(key, { ...window })
  }
  return [...seen.values()]
}

/**
 * The full L2 block.
 *
 * `size_cap` is the *minimum* of the vol cap and the event cap, never their
 * product: two independent reasons to be careful do not compound into a
 * quarter-size position, they just mean take the more careful of the two.
 *
 * @param {object} input
 * @param {Array<object>} input.calendar the weekly feed
 * @param {'calm'|'elevated'|'hostile'} input.volRegime
 * @param {{size_cap: number, spm_allowed: boolean, mm_preferred: boolean}} input.volEffect
 * @param {number} input.now epoch ms
 */
export function classifyDay({ calendar, volRegime, volEffect, now }) {
  const date = etDate(now)
  const flags = dateFlags(date)
  const horizon = horizonOf(calendar, date)

  // A feed that stops before today cannot say today is normal.
  //
  // This is the failure the horizon warning exists to prevent, one level up: a
  // stale weekly file still parses, still contains no events dated today, and
  // therefore still yields `day_type: 'normal'`, `cap 100%`, `SPM allowed` — a
  // confident all-clear derived from a file that has never heard of today. On a
  // CPI morning behind a broken refresh that is the worst output mac could
  // produce, so an uncovered feed is treated exactly like no feed at all.
  if (!horizon.covers_today) {
    return {
      day_type: null,
      size_cap: volEffect.size_cap,
      spm_allowed: volEffect.spm_allowed,
      mm_preferred: volEffect.mm_preferred,
      no_trade_windows: [],
      flags,
      stale: true,
      events_today: [],
      events_next_5: [],
      horizon_sessions: 0,
      horizon_ends: null,
      feed_ends: horizon.feed_ends,
      horizon_truncated: true,
    }
  }

  const today = eventsOn(calendar, date)

  const tier1 = today.filter((event) => event.tier === 1)
  const tier2 = today.filter((event) => event.tier === 2)
  const auctions = today.filter((event) => event.auction)

  const eventCap = tier1.length ? SIZE_CAP.tier1 : tier2.length ? SIZE_CAP.tier2 : SIZE_CAP.normal

  let dayType = 'normal'
  if (tier1.length) dayType = 'tier1_event'
  else if (tier2.length) dayType = 'tier2_event'
  else if (auctions.length) dayType = 'auction_day'
  else if (flags.quarter_end) dayType = 'quarter_end'

  // "Within the session window" is narrow on purpose: most Tier 1 prints land
  // at 08:30 ET, an hour before the open, and the model has an hour to read the
  // reaction. It is the ones that land *inside* 09:30–12:00 that leave no time.
  const session = nySessionWindow(now)
  const tier1InSession = tier1.some(
    (event) => event.dt.getTime() >= session.open && event.dt.getTime() <= session.noon
  )

  return {
    day_type: dayType,
    size_cap: Math.min(volEffect.size_cap, eventCap),
    spm_allowed: volRegime !== 'hostile' && !tier1InSession,
    mm_preferred: volRegime === 'hostile' || (tier1.length > 0 && volRegime === 'elevated'),
    no_trade_windows: noTradeWindows(today, date),
    flags,
    stale: false,
    events_today: today.map(summarise),
    events_next_5: horizon.events,
    horizon_sessions: horizon.sessions,
    horizon_ends: horizon.ends,
    feed_ends: horizon.feed_ends,
    horizon_truncated: horizon.truncated,
  }
}

const summarise = (event) => ({
  title: event.title,
  impact: event.impact,
  tier: event.tier,
  auction: event.auction,
  date: etDate(event.dt.getTime()),
  timeET: timeET(event.dt),
  timeLabel: timeLabel(event.dt),
  forecast: event.forecast || null,
  previous: event.previous || null,
})

/**
 * Events over the next five sessions, and an honest statement of how far the
 * feed actually reached.
 *
 * `truncated` is the field that matters. Without it a Thursday read shows two
 * sessions of events and looks indistinguishable from a genuinely quiet week.
 */
export function horizonOf(calendar, date, sessions = 5) {
  const wanted = sessionsFrom(date, sessions)
  const events = wanted.flatMap((day) => eventsOn(calendar, day).map(summarise))

  const covered = (Array.isArray(calendar) ? calendar : [])
    .map((event) => new Date(event.date))
    .filter((dt) => Number.isFinite(dt.getTime()))
    .map((dt) => etDate(dt.getTime()))
    .sort()

  // Null, not today. An empty or expired feed reaches nowhere, and reporting
  // today as the end date would read as "checked through today" — the precise
  // opposite of the truth.
  const feedEnds = covered.length ? covered[covered.length - 1] : null
  const reached = feedEnds ? wanted.filter((day) => day <= feedEnds) : []

  return {
    events,
    sessions: reached.length,
    ends: reached.length ? reached[reached.length - 1] : null,
    feed_ends: feedEnds,
    // The feed has to actually reach today before anything it says about today
    // can be believed.
    covers_today: feedEnds != null && feedEnds >= date,
    truncated: reached.length < wanted.length,
  }
}
