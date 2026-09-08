/**
 * The mac pipeline: fetch → carry → compute → store.
 *
 * The thin I/O sequence over the pure modules in `src/domain/mac/`, with every
 * dependency injected so it can run against fakes. Same shape as
 * `finski/brief.js` — nothing here imports Supabase directly.
 */

import { buildSnapshot } from '../../../domain/mac/snapshot.js'
import { etDate } from '../../../domain/et-session.js'

/**
 * Computes and stores today's snapshot.
 *
 * A failed save does not fail the snapshot. The numbers are already computed
 * and the trader needs them before the open; losing the row costs tomorrow's
 * hysteresis a day of memory, which is the lesser harm. The caller is told via
 * `saved` — and it matters more here than it does for a brief, because an
 * unsaved snapshot means tomorrow's confirmation counters restart.
 *
 * @param {object} input
 * @param {{value: number, date: string}|null} [input.pmiEntry] manual ISM entry
 * @param {number} [input.now] epoch ms
 * @param {object} deps
 * @returns {Promise<{snapshot: object, failed: Record<string, string>,
 *   saved: boolean, saveError: Error|null, calendarError: Error|null}>}
 */
export async function runMac(
  { pmiEntry = null, now = Date.now() } = {},
  { fetchSeries, fetchCalendar, priorSnapshot, saveSnapshot, onProgress = () => {} }
) {
  const today = etDate(now)

  onProgress('Fetching FRED series…')
  const { series, failed } = await fetchSeries()

  // The calendar is optional: it types the day and harvests ISM, but a factor
  // read is still worth having without it. A failure here degrades L2 to
  // vol-only and shows up in `data_health` as a missing calendar, rather than
  // taking the whole snapshot down with it.
  onProgress('Fetching calendar…')
  let calendar = null
  let calendarError = null
  try {
    calendar = (await fetchCalendar()).events
  } catch (err) {
    calendarError = err
  }

  onProgress('Reading yesterday…')
  const prior = await priorSnapshot(today)

  onProgress('Computing factors…')
  const snapshot = buildSnapshot({
    series,
    prior,
    pmiEntry,
    calendar,
    fetchErrors: failed,
    today,
    now,
    computedAt: new Date(now).toISOString(),
  })

  let saved = true
  let saveError = null
  try {
    await saveSnapshot(snapshot)
  } catch (err) {
    saved = false
    saveError = err
  }

  return { snapshot, failed, saved, saveError, calendarError }
}
