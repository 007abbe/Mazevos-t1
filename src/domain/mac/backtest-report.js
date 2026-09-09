/**
 * Scoring the replay: does mac's lean correspond to anything?
 *
 * The live Validation report asks whether the regime separated *your trades*.
 * This asks the prior question, and a much more answerable one: does the bar
 * separate the *index*. It needs no fills, so it can be run backwards over
 * fifteen years instead of forwards over as many months.
 *
 * What is being tested is one claim — "longs may have a tailwind today". So the
 * measurement is deliberately literal: bucket the sessions by what mac said
 * that morning, and look at what the index did that day.
 *
 * Three things this file refuses to do, each of which would make the answer
 * look better than it is:
 *
 *   **No p-values from raw n.** Sessions in the same regime are not independent
 *   — mac holds a label for weeks at a time, so 3,000 sessions might carry a
 *   few hundred independent macro episodes. A t-test on the raw count would
 *   report significance that the data cannot support. The block bootstrap below
 *   resamples contiguous stretches instead, which keeps that structure.
 *
 *   **No bucket without its n.** Every row carries its own count, so a cell
 *   built on nine sessions is visibly built on nine sessions.
 *
 *   **No comparison without the base rate.** The index rises on most days. A
 *   bull bucket that is up 54% of the time has said nothing, and only looks
 *   impressive next to 50%.
 *
 * Everything here is pure.
 */

/** Buckets over `bull_pct`, matching the bar's own published labels. */
export const BUCKETS = [
  { key: 'bear', min: 0, max: 44, text: 'bear / leaning bear' },
  { key: 'neutral', min: 45, max: 54, text: 'neutral' },
  { key: 'leaning_bull', min: 55, max: 64, text: 'leaning bull' },
  { key: 'bull', min: 65, max: 100, text: 'bull / strong bull' },
]

export const bucketOf = (bullPct) =>
  BUCKETS.find((b) => bullPct >= b.min && bullPct <= b.max) ?? null

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** Return in basis points, which is the only readable unit for daily moves. */
const bps = (x) => (x == null ? null : Math.round(x * 1_000_000) / 100)

function summarise(returns) {
  if (!returns.length) {
    return { n: 0, mean_bps: null, hit_rate: null, median_bps: null, sd_bps: null, p05_bps: null }
  }

  const sorted = [...returns].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const avg = mean(returns)

  // Dispersion and the left tail, not just the average.
  //
  // mac's size cap is a statement about risk, and a mean return says nothing
  // about risk. A regime can carry a perfectly ordinary mean while doubling the
  // spread of outcomes around it — which is precisely the case the cap exists
  // for, and precisely what a table of means would report as "no effect".
  const variance =
    returns.length > 1
      ? returns.reduce((sum, r) => sum + (r - avg) ** 2, 0) / (returns.length - 1)
      : 0

  return {
    n: returns.length,
    mean_bps: bps(avg),
    median_bps: bps(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
    sd_bps: bps(Math.sqrt(variance)),
    p05_bps: bps(sorted[Math.floor(sorted.length * 0.05)]),
    hit_rate: Math.round((returns.filter((r) => r > 0).length / returns.length) * 1000) / 10,
  }
}

/**
 * A deterministic PRNG, so a report is reproducible.
 *
 * A bootstrap that moves every time it is run invites re-running until the
 * interval is flattering. Seeding it removes that temptation entirely.
 */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * Confidence interval for the bull-minus-bear spread, by moving block bootstrap.
 *
 * Contiguous blocks, not individual sessions: mac's label persists, so the
 * sequence of (label, return) pairs is autocorrelated and resampling days
 * independently would destroy exactly the structure that makes the effective
 * sample smaller than the raw one. A block long enough to span a typical regime
 * stretch keeps it.
 *
 * The interval is over the *difference* between the top and bottom buckets,
 * because that difference is the claim. A bull bucket with a positive mean
 * proves nothing on its own — the index drifts up, so every bucket should be
 * positive.
 *
 * @param {Array<{bucket: string, ret: number}>} rows in session order
 * @param {object} [options]
 * @returns {{low_bps: number, high_bps: number, point_bps: number, iterations: number,
 *   block: number}|null}
 */
export function spreadInterval(
  rows,
  {
    block = 21,
    iterations = 2000,
    seed = 20260909,
    positive = ['bull', 'leaning_bull'],
    negative = ['bear'],
  } = {}
) {
  const spreadOf = (sample) => {
    const up = sample.filter((r) => positive.includes(r.bucket))
    const down = sample.filter((r) => negative.includes(r.bucket))
    if (!up.length || !down.length) return null
    return mean(up.map((r) => r.ret)) - mean(down.map((r) => r.ret))
  }

  const point = spreadOf(rows)
  if (point == null || rows.length < block * 4) return null

  const random = rng(seed)
  const blocks = Math.ceil(rows.length / block)
  const spreads = []

  for (let i = 0; i < iterations; i += 1) {
    const sample = []
    for (let b = 0; b < blocks; b += 1) {
      const start = Math.floor(random() * (rows.length - block))
      sample.push(...rows.slice(start, start + block))
    }
    const spread = spreadOf(sample)
    if (spread != null) spreads.push(spread)
  }

  if (spreads.length < iterations / 2) return null
  spreads.sort((a, b) => a - b)

  return {
    point_bps: bps(point),
    low_bps: bps(spreads[Math.floor(spreads.length * 0.025)]),
    high_bps: bps(spreads[Math.floor(spreads.length * 0.975)]),
    iterations: spreads.length,
    block,
  }
}

/**
 * Whether mean return rises with the lean, which is the actual hypothesis.
 *
 * Reported as the number of adjacent pairs in the right order rather than as a
 * correlation, because with four buckets a rank correlation is a single noisy
 * number and "3 of 3 steps up" says plainly what happened.
 */
export function monotonicity(buckets) {
  const usable = buckets.filter((b) => b.n > 0)
  let ordered = 0

  for (let i = 1; i < usable.length; i += 1) {
    if (usable[i].mean_bps >= usable[i - 1].mean_bps) ordered += 1
  }

  return { steps: Math.max(0, usable.length - 1), ordered }
}

/**
 * The full report.
 *
 * @param {Array<{date: string, bull_pct: number, label: string, vol_regime: string,
 *   ret: number}>} sessions in date order, each with the return of the session
 *   mac was scoring that morning
 */
export function buildReport(sessions, { field = 'ret', block = 21 } = {}) {
  const rows = (sessions ?? [])
    .filter((s) => Number.isFinite(s?.[field]) && Number.isFinite(s?.bull_pct))
    .map((s) => ({ ...s, ret: s[field] }))

  const tagged = rows.map((s) => ({ ...s, bucket: bucketOf(s.bull_pct)?.key ?? null }))

  const buckets = BUCKETS.map((b) => ({
    key: b.key,
    text: b.text,
    range: `${b.min}–${b.max}`,
    ...summarise(tagged.filter((s) => s.bucket === b.key).map((s) => s.ret)),
  }))

  const byVol = ['calm', 'elevated', 'hostile'].map((regime) => ({
    regime,
    ...summarise(tagged.filter((s) => s.vol_regime === regime).map((s) => s.ret)),
  }))

  return {
    span: rows.length ? { from: rows[0].date, to: rows[rows.length - 1].date } : null,
    // The number every bucket has to beat. Without it a positive mean is just
    // the equity risk premium showing up on schedule.
    base: summarise(rows.map((s) => s.ret)),
    buckets,
    by_vol: byVol,
    monotonicity: monotonicity(buckets),
    spread: spreadInterval(tagged, { block }),
  }
}

/* ----------------------------------------------------- per-factor testing -- */

/**
 * One factor against the index, bucketed by the sign of its state.
 *
 * The composite bar showing nothing is compatible with three quite different
 * situations, and they have opposite remedies: no factor carries any signal; or
 * some do and the equal-weight sum averages them away against the ones that do
 * not; or two carry signal with opposite signs and cancel. This is what tells
 * them apart.
 *
 * Sign, not level: the states run −3 to +2 and slicing six ways leaves cells too
 * thin to read. What the convention actually claims is directional — negative is
 * an NQ headwind — so the sign is the claim, and it is what gets tested.
 *
 * A factor that separates *inversely*, consistently, in both halves of the
 * sample, is not a dead factor. It is a flipped sign, and it will have been
 * dragging the composite toward zero the whole time.
 *
 * @param {Array<object>} sessions
 * @param {string} field the property holding the factor state
 */
export function signReport(sessions, field, { ret = 'ret', block = 21 } = {}) {
  const rows = (sessions ?? [])
    .filter((s) => Number.isFinite(s?.[ret]) && Number.isFinite(s?.[field]))
    .map((s) => ({ ...s, ret: s[ret] }))

  const tagged = rows.map((s) => ({
    ...s,
    bucket: s[field] > 0 ? 'positive' : s[field] < 0 ? 'negative' : 'zero',
  }))

  const buckets = ['negative', 'zero', 'positive'].map((key) => ({
    key,
    ...summarise(tagged.filter((s) => s.bucket === key).map((s) => s.ret)),
  }))

  return {
    field,
    n: rows.length,
    buckets,
    spread: spreadInterval(tagged, { block, positive: ['positive'], negative: ['negative'] }),
  }
}

/**
 * How many independent tests are being run, and what that does to a 95% interval.
 *
 * Six factors searched at once is not six confirmations waiting to happen; it is
 * six chances for noise to clear the bar. Stated as a number rather than left
 * for the reader to remember, because the whole point of a sweep like this is
 * that something usually looks good in it.
 *
 * @param {number} tests
 * @returns {number} probability at least one false positive, as a percentage
 */
export const familywiseRisk = (tests) => Math.round((1 - 0.95 ** tests) * 1000) / 10

/**
 * The block length for a given holding horizon.
 *
 * Overlapping forward returns share all but one of their days, so consecutive
 * observations at a 20-session horizon are ~95% the same data. A 21-session
 * block that was ample for daily returns is far too short for those: it would
 * resample chunks smaller than the dependence itself and report an interval
 * several times tighter than the evidence supports.
 *
 * Four times the horizon, floored at the daily block, keeps each resampled
 * stretch long enough to contain genuinely independent episodes.
 */
export const blockFor = (horizon) => Math.max(21, horizon * 4)

/**
 * Roughly how many independent observations an overlapping sample holds.
 *
 * Reported alongside the raw count because the two diverge fast: 2,500 sessions
 * of 20-day returns is about 125 independent readings, and a table that shows
 * only the first number invites reading far more into a result than is there.
 */
export const effectiveN = (n, horizon) => Math.floor(n / Math.max(1, horizon))
