/**
 * The confirmation rule every factor shares.
 *
 * mac is a state machine, not a scoreboard. Today's data produces a
 * *candidate* state; this module decides whether the candidate has earned the
 * right to become the published state. Entering a state is harder than staying
 * in it, which is what turns a number that wobbles daily into "tailwind this
 * week, still tailwind next week unless X".
 *
 * The carried state is small and lives inside the snapshot, so yesterday's
 * snapshot is the only history a recompute needs:
 *
 * @typedef {object} FactorMemory
 * @property {number} state the published state
 * @property {number|null} candidate what has been arguing against it
 * @property {number} streak consecutive readings that candidate has held
 * @property {string|null} [releasedOn] latest input date the state was built
 *   from, for the release-gated factors
 */

/**
 * What a factor with no history starts from: neutral, nothing pending. Every
 * key is present, so a first run and a restored run have the same shape and no
 * caller has to test for one.
 */
export const INITIAL = Object.freeze({
  state: 0,
  candidate: null,
  streak: 0,
  releasedOn: null,
})

/**
 * Normalises whatever came back from storage into a usable memory.
 *
 * Extra keys are preserved. Several factors carry their own counters alongside
 * the shared ones — F5's latched speed override, F4's last H.4.1 date, F1's
 * three-week claims vote — and dropping them here would silently reset those
 * every single day while the shared fields kept working, which is the kind of
 * bug that produces a plausible number and no error.
 */
export function memory(prior) {
  if (!prior || typeof prior !== 'object') return { ...INITIAL }

  // The per-run flags are not memory. Carrying `carried: true` into the next
  // day would mark a freshly computed factor as stale for the rest of its life.
  const { changed, pending, carried, ...rest } = prior

  return {
    ...rest,
    state: Number.isFinite(prior.state) ? prior.state : 0,
    candidate: Number.isFinite(prior.candidate) ? prior.candidate : null,
    streak: Number.isFinite(prior.streak) ? prior.streak : 0,
    releasedOn: prior.releasedOn ?? null,
  }
}

/**
 * Applies confirmation to one factor.
 *
 * @param {object} input
 * @param {number} input.candidate the state today's data argues for
 * @param {FactorMemory} input.prior yesterday's memory
 * @param {number} input.confirmations consecutive readings needed to flip
 * @param {(candidate: number, state: number) => boolean} [input.immediate]
 *   an escape hatch for states that must not wait — F7 entering `hostile`, F5's
 *   speed override. Applies to *entering*; leaving still needs confirmation,
 *   which is the whole asymmetry.
 * @returns {FactorMemory & {changed: boolean, pending: boolean}}
 */
export function confirm({ candidate, prior, confirmations = 1, immediate }) {
  const before = memory(prior)

  // Nothing to confirm. Clearing the streak matters: a candidate that argued
  // for two days and then agreed with the published state must start over, not
  // resume from two if it comes back.
  if (candidate === before.state) {
    return { ...before, candidate: null, streak: 0, changed: false, pending: false }
  }

  if (immediate?.(candidate, before.state)) {
    return { ...before, state: candidate, candidate: null, streak: 0, changed: true, pending: false }
  }

  // A different candidate than the one that was pending restarts the count at
  // one — today is its first reading, not a continuation of someone else's.
  const streak = candidate === before.candidate ? before.streak + 1 : 1

  if (streak >= confirmations) {
    return { ...before, state: candidate, candidate: null, streak: 0, changed: true, pending: false }
  }

  return { ...before, candidate, streak, changed: false, pending: true }
}

/**
 * Confirmation for the monthly factors, where the calendar does the work.
 *
 * Core CPI does not become more true by being looked at on a Tuesday. These
 * factors change only when a genuinely new observation has been published, so
 * the gate is the input's own date rather than a count of sessions. Between
 * releases the state is held exactly as it was.
 *
 * @param {object} input
 * @param {number} input.candidate
 * @param {FactorMemory} input.prior
 * @param {string|null} input.releaseDate latest input observation date
 * @returns {FactorMemory & {changed: boolean, pending: boolean}}
 */
export function confirmOnRelease({ candidate, prior, releaseDate }) {
  const before = memory(prior)

  if (!releaseDate) return { ...before, changed: false, pending: false }

  // First ever computation has nothing to compare against, so the first read
  // establishes the state rather than waiting a month for the next print.
  const isNew = before.releasedOn == null || releaseDate > before.releasedOn
  if (!isNew) return { ...before, changed: false, pending: false }

  return {
    ...before,
    state: candidate,
    candidate: null,
    streak: 0,
    releasedOn: releaseDate,
    changed: candidate !== before.state,
    pending: false,
  }
}

/**
 * Holds a factor exactly as it was. Used when an input is stale or missing:
 * the last honest state is better than a state computed from a gap, and the
 * carry is reported in `data_health` so nobody mistakes it for a fresh read.
 */
export function carryForward(prior) {
  const before = memory(prior)
  return { ...before, changed: false, pending: false, carried: true }
}
