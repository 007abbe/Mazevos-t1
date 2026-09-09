/**
 * Reads the ISM prints harvested by the "Fetch FF calendar" Action.
 *
 * The file at `public/data/ism_pmi.json` is written by `scripts/fetch-ism.mjs`,
 * which scrapes ForexFactory's calendar page for the one field the weekly JSON
 * feed does not carry: `actual`. Same arrangement as the calendar itself, and
 * for the same reason — the page sends no CORS headers, so the fetch has to
 * happen in the Action and the browser reads the result from our own origin.
 *
 * There is no fallback URL here, deliberately. The calendar has one because a
 * stale calendar is dangerous and worth a second attempt; a missing ISM file
 * just means F1 falls back to the feed's one-month-old `previous`, which is the
 * behaviour mac shipped with.
 */

/** Same-origin file written by the Action. Resolved against Vite's base. */
export const ISM_PATH = 'data/ism_pmi.json'

const ismUrl = () => `${import.meta.env?.BASE_URL ?? '/'}${ISM_PATH}`

/**
 * Harvested ISM prints, oldest first, or an empty list.
 *
 * Never throws. A 404 before the Action has run once, a truncated deploy, or a
 * malformed file all mean the same thing to the caller — no scraped prints —
 * and none of them should take the snapshot down. `resolvePmi` merges whatever
 * comes back with the other two sources.
 *
 * @returns {Promise<Array<{date: string, value: number, release_date?: string}>>}
 */
export async function fetchIsmActuals({ fetchImpl = globalThis.fetch, url = ismUrl() } = {}) {
  try {
    const res = await fetchImpl(url, { cache: 'no-cache' })
    if (!res.ok) return []

    const body = await res.json()
    return Array.isArray(body?.entries) ? body.entries : []
  } catch {
    return []
  }
}

// Whether the harvest has gone stale is decided by `harvestHealth` in
// src/domain/mac/ff-actuals.js — it is a rule with a threshold in it, so it
// lives where `node --test` can reach it. This file only does I/O.
