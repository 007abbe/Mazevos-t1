/**
 * Economic calendar for Finski.
 *
 * Source is the ForexFactory weekly JSON. We read it from our own origin —
 * `public/data/ff_calendar.json`, refreshed by the "Fetch FF calendar" Action —
 * because the upstream feed sends no CORS headers and a direct browser fetch is
 * blocked in most browsers. The direct feed stays as a second chance, and a
 * stale cache as a third, so a failed Action degrades rather than blocks.
 *
 * Everything date- and time-related is decided in New York time: which events
 * count as "today", how they sort, what the rules compare against. CET appears
 * only inside pre-formatted display strings.
 */

import { etDate, timeCET, timeET, timeLabel } from '../../domain/et-session.js'

/** Same-origin copy written by the GitHub Action. Resolved against Vite's base. */
export const CALENDAR_PATH = 'data/ff_calendar.json'

/** Upstream feed. CORS-blocked in most browsers; worth one attempt anyway. */
export const CALENDAR_FALLBACK_URL =
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json'

export const CACHE_KEY = 'finski_cal_cache'
export const CACHE_TTL_MS = 60 * 60 * 1000

/** Impacts the model cares about. Low-impact prints do not move NQ. */
const RELEVANT_IMPACTS = ['High', 'Medium']

const calendarUrl = () => `${import.meta.env?.BASE_URL ?? '/'}${CALENDAR_PATH}`

/**
 * Today's USD High/Medium events in New York terms, chronological.
 *
 * Adds the display fields the rules and UI quote. `dt` is the instant; treat it
 * as the only sortable/comparable time on the object.
 *
 * @param {Array<object>} all every event in the weekly feed
 * @param {number} now epoch ms
 */
export function todayUsdEvents(all, now) {
  const today = etDate(now)

  return (Array.isArray(all) ? all : [])
    .map((event) => ({ ...event, dt: new Date(event.date) }))
    .filter(
      (event) =>
        event.country === 'USD' &&
        RELEVANT_IMPACTS.includes(event.impact) &&
        // A malformed date would otherwise reach the rules as an Invalid Date
        // and compare false against every window, silently.
        Number.isFinite(event.dt.getTime()) &&
        etDate(event.dt.getTime()) === today
    )
    .map((event) => ({
      ...event,
      timeET: timeET(event.dt),
      timeCET: timeCET(event.dt),
      timeLabel: timeLabel(event.dt),
    }))
    .sort((a, b) => a.dt - b.dt)
}

/**
 * @param {Storage} storage
 * @param {number} now epoch ms
 * @returns {{events: Array<object>, fresh: boolean}|null}
 */
export function readCache(storage, now) {
  let cached
  try {
    cached = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null')
  } catch {
    return null // Corrupt entry — treat as a miss rather than throwing.
  }

  if (!cached || !Array.isArray(cached.data) || !Number.isFinite(cached.ts)) {
    return null
  }

  return { events: cached.data, fresh: now - cached.ts < CACHE_TTL_MS }
}

export function writeCache(storage, events, now) {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify({ ts: now, data: events }))
  } catch {
    // Private mode or a full quota. The calendar still works, just uncached.
  }
}

async function fetchJsonArray(fetchImpl, url) {
  const res = await fetchImpl(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('non-array JSON')
  return data
}

/**
 * The full weekly feed, cached for an hour.
 *
 * Dependencies are injected so this is testable without a browser; the defaults
 * are the real ones.
 *
 * @returns {Promise<{events: Array<object>, fromCache: boolean, stale?: boolean}>}
 */
export async function fetchCalendar({
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  now = Date.now(),
  url = calendarUrl(),
  fallbackUrl = CALENDAR_FALLBACK_URL,
} = {}) {
  const cached = readCache(storage, now)
  if (cached?.fresh) return { events: cached.events, fromCache: true }

  let repoError
  try {
    const events = await fetchJsonArray(fetchImpl, url)
    writeCache(storage, events, now)
    return { events, fromCache: false }
  } catch (err) {
    repoError = err
  }

  try {
    const events = await fetchJsonArray(fetchImpl, fallbackUrl)
    writeCache(storage, events, now)
    return { events, fromCache: false }
  } catch (feedError) {
    // An expired cache still beats no brief at all — the UI flags it as stale.
    if (cached) return { events: cached.events, fromCache: true, stale: true }

    throw new Error(
      `Calendar unavailable. Repo file: ${repoError.message} — run the ` +
        `"Fetch FF calendar" Action in GitHub, then retry. ` +
        `Direct feed: ${feedError.message}`
    )
  }
}
