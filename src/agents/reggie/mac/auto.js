/**
 * Runs mac once a day, on app load.
 *
 * The spec puts mac in a pre-market runner alongside GEX. There is no such
 * runner in this repo, and building one means a scheduled job writing rows on
 * your behalf — which means a service-role key in CI, a key that bypasses RLS
 * entirely. That is a large widening of blast radius for a single-user app
 * whose owner opens it most weekday mornings anyway.
 *
 * So: whenever the app loads and today has no snapshot, compute one in the
 * background. No new secrets, no new infrastructure, and the hysteresis
 * counters get fed on every day you actually trade.
 *
 * What this deliberately does not do is guarantee an unbroken daily series. A
 * day you never open Mazevo has no snapshot, and the next run reads the last
 * one that exists rather than "yesterday" — which is exactly why
 * `priorSnapshot` selects on `date < today` instead of on a computed yesterday.
 * A gap costs those days' confirmations, not correctness.
 */

/**
 * Nothing Supabase-touching is imported here. `src/lib/supabase.js` reads
 * `import.meta.env` at module load, which is undefined outside Vite, so a
 * module that reaches it cannot be run by `node --test` at all. Every
 * dependency arrives through the argument instead — the same reason
 * `generateBrief` and `runMac` are shaped this way. `reggie/index.js` supplies
 * the real ones.
 */

import { etDate } from '../../../domain/et-session.js'

/** Set while a run is in flight, so two views mounting cannot both start one. */
let inFlight = null

/**
 * Computes today's snapshot if it is missing.
 *
 * Silent by design: this runs behind whatever view the user actually opened, so
 * a failure here must not surface as an error over their journal. The Reggie
 * panel is where mac reports for itself — this is only a scheduler.
 *
 * @param {object} input
 * @param {(date: string) => Promise<object|null>} input.read reads a stored snapshot
 * @param {(opts: object, deps: object) => Promise<object>} input.compute the mac pipeline
 * @param {object} input.deps what `compute` needs
 * @param {number} [input.now] epoch ms
 * @returns {Promise<{ran: boolean, reason?: string, snapshot?: object}>}
 */
export function ensureTodaySnapshot(input) {
  if (inFlight) return inFlight

  inFlight = run(input).finally(() => {
    inFlight = null
  })

  return inFlight
}

async function run({ now = Date.now(), read, compute, deps }) {
  const today = etDate(now)

  try {
    if (await read(today)) return { ran: false, reason: 'already computed' }
  } catch {
    // Not signed in yet, table missing, offline. All the same answer: not now.
    return { ran: false, reason: 'could not read today' }
  }

  try {
    const result = await compute({ now }, deps)
    return { ran: true, snapshot: result.snapshot }
  } catch (err) {
    return { ran: false, reason: err?.message ?? 'compute failed' }
  }
}

/** Testing seam: clears the in-flight guard between cases. */
export function resetAutoRun() {
  inFlight = null
}
