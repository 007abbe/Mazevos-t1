/**
 * Phase 4: does the regime actually separate anything?
 *
 * Everything mac asserts today — HY at 300bps, VIX at 30, the ×6 scale on the
 * bar — came from the spec, not from your fills. This module is where those
 * numbers are held against the record. It computes; it never concludes on thin
 * evidence, and the honest answer for the first few months is "not enough data",
 * which is what it will say.
 *
 * The governing rule, from the spec: **fix definitions, never trades.** If
 * hostile sessions turn out not to hurt STDV, the vol thresholds are wrong. It
 * never means "trade STDV differently to make the thresholds right".
 *
 * The two halves have very different data appetites, and keeping them apart is
 * the point of the file:
 *
 *   - **Bar calibration** needs no trades at all. One data point per session,
 *     from stored snapshots against NDX closes — the same `NASDAQ100` series F7
 *     already pulls. It fills whether or not you traded.
 *   - **Trade separation** needs enough fills *per bucket*, which is far slower,
 *     and `hostile` may take a year or a shock to populate at all.
 *
 * Backtest rows never reach here. The caller passes live trades only: the whole
 * reason the Backtest scope exists is to keep unfilled ideas out of live
 * statistics, and letting them into an expectancy test would breach exactly the
 * boundary it was built for.
 */

import { actualR, expectancy } from '../discretion.js'

/**
 * Rows per bucket before a bucket is allowed to say anything.
 *
 * Twenty is not a statistically satisfying number; it is the point below which a
 * mean R is obviously noise rather than subtly noise. Every row reports its own
 * `n` regardless, so a thin cell is visible rather than merely flagged.
 */
export const MIN_BUCKET_N = 20

/** Sessions needed before the calibration curve is worth refitting against. */
export const MIN_CALIBRATION_SESSIONS = 60

/**
 * mac is display-only until this flips.
 *
 * The spec asks for the regime to be logged "visible but not gating", and there
 * is a trap in that: mac already renders a 50% size cap on a hostile day. Act on
 * it during the logging window and hostile sessions get systematically smaller,
 * more selective trades — at which point the comparison measures your compliance
 * with mac rather than the regime's effect, and Phase 4 validates a loop it is
 * standing inside.
 *
 * So this stays false until the validation report shows separation, and the UI
 * says so on the card. Flipping it is a deliberate act with evidence behind it,
 * not a default that drifted.
 */
export const GATING_ENABLED = false

export const LOGGING_NOTICE =
  'Logging phase — display only. Do not size off this: acting on the cap now ' +
  'contaminates the sample Phase 4 measures.'

/* ------------------------------------------------------ bar calibration ---- */

/**
 * Buckets for the calibration curve.
 *
 * Five, not the bar's seven labels: at 60–100 sessions, seven buckets leaves
 * cells holding four sessions, and a share-of-green computed on four sessions is
 * a coin flip wearing a percentage sign.
 */
export const BAR_BUCKETS = [
  { max: 35, label: '≤35', mid: 28 },
  { max: 45, label: '36–45', mid: 40 },
  { max: 54, label: '46–54', mid: 50 },
  { max: 64, label: '55–64', mid: 60 },
  { max: 100, label: '≥65', mid: 72 },
]

const bucketFor = (bullPct) => BAR_BUCKETS.find((b) => bullPct <= b.max) ?? BAR_BUCKETS[4]

/**
 * Whether each session closed green, from a daily close series.
 *
 * Keyed by date so a snapshot can look itself up. The comparison is against the
 * previous *observation*, not the previous calendar day — a Monday is measured
 * against Friday, which is what a session return is.
 *
 * @param {Array<{date: string, value: number}>} closes ascending
 * @returns {Map<string, boolean>}
 */
export function greenSessions(closes) {
  const out = new Map()
  for (let i = 1; i < closes.length; i += 1) {
    out.set(closes[i].date, closes[i].value > closes[i - 1].value)
  }
  return out
}

/**
 * The calibration curve: what the bar predicted against what happened.
 *
 * A snapshot's `bull_pct` is computed pre-market for that session, so it is
 * scored against that same date's close — not the next one. Sessions with no
 * matching close (a holiday, a gap in the series) are dropped rather than
 * guessed at.
 *
 * @param {Array<{date: string, snapshot: object}>} rows stored snapshots
 * @param {Array<{date: string, value: number}>} closes NDX daily closes
 */
export function barCalibration(rows, closes) {
  const green = greenSessions(closes)

  const buckets = BAR_BUCKETS.map((bucket) => ({
    ...bucket,
    n: 0,
    green: 0,
  }))

  let matched = 0

  for (const row of rows ?? []) {
    const bullPct = row?.snapshot?.l1?.bar?.bull_pct
    const date = row?.snapshot?.date ?? row?.date
    if (!Number.isFinite(bullPct) || !green.has(date)) continue

    matched += 1
    const bucket = buckets.find((b) => b.label === bucketFor(bullPct).label)
    bucket.n += 1
    if (green.get(date)) bucket.green += 1
  }

  return {
    sessions: matched,
    enough: matched >= MIN_CALIBRATION_SESSIONS,
    buckets: buckets.map((bucket) => ({
      label: bucket.label,
      predicted: bucket.mid,
      n: bucket.n,
      // Null, not zero: a bucket nothing landed in has no measured rate, and
      // rendering 0% would read as "never green".
      actual: bucket.n ? Math.round((bucket.green / bucket.n) * 100) : null,
      enough: bucket.n >= MIN_BUCKET_N,
    })),
  }
}

/* ----------------------------------------------------- trade separation ---- */

/** The bar's seven labels collapsed to three, for the same reason as above. */
export const BIAS_GROUPS = {
  strong_bear: 'bear',
  bear: 'bear',
  leaning_bear: 'bear',
  neutral: 'neutral',
  leaning_bull: 'bull',
  bull: 'bull',
  strong_bull: 'bull',
}

export const VOL_BUCKETS = ['calm', 'elevated', 'hostile']
export const BIAS_BUCKETS = ['bear', 'neutral', 'bull']

/** Win rate over rows that have a measurable R. */
function winRate(trades) {
  const rs = trades.map(actualR).filter((r) => r !== null)
  if (!rs.length) return null
  return Math.round((rs.filter((r) => r > 0).length / rs.length) * 100)
}

/**
 * Expectancy, win rate and n for one group of trades.
 *
 * `enough` is carried per row rather than filtered on, so a thin bucket is
 * visible in the table instead of silently absent — an empty row and a missing
 * row say very different things about why a test is inconclusive.
 */
export function bucketStats(trades) {
  const { n, r } = expectancy(trades)
  return { n, r, win_rate: winRate(trades), enough: n >= MIN_BUCKET_N }
}

/**
 * Expectancy by bucket for one model.
 *
 * @param {object[]} trades live trades only
 * @param {string} model 'STDV' or 'MM'
 * @param {'vol_regime'|'regime_bias'} key
 */
export function splitBy(trades, model, key) {
  const scoped = (trades ?? []).filter((t) => (t?.model ?? null) === model)
  const buckets = key === 'vol_regime' ? VOL_BUCKETS : BIAS_BUCKETS

  const rows = buckets.map((bucket) => ({
    bucket,
    ...bucketStats(
      scoped.filter((t) => {
        const value = key === 'vol_regime' ? t?.vol_regime : BIAS_GROUPS[t?.regime_bias]
        return value === bucket
      })
    ),
  }))

  // Trades logged before mac carry null across all four columns. Counting them
  // is how you notice that most of the journal predates the experiment.
  const unstamped = scoped.filter((t) => t?.[key] == null).length

  return { model, key, rows, unstamped, total: scoped.length }
}

/* ---------------------------------------------------------- the verdict ---- */

/**
 * Whether a split shows separation, stated conservatively.
 *
 * Only ever returns `separated` when the two ends of the range both cleared
 * `MIN_BUCKET_N` and their expectancies differ by more than `margin` R. There is
 * no significance test here on purpose — with these sample sizes a p-value would
 * lend an authority the data does not have. This is a screen, not a proof, and
 * it says so.
 */
export function verdictFor(split, { low, high, margin = 0.2 } = {}) {
  const at = (bucket) => split.rows.find((row) => row.bucket === bucket)
  const a = at(low)
  const b = at(high)

  if (!a?.enough || !b?.enough) {
    const need = [a, b]
      .filter((row) => row && !row.enough)
      .map((row) => `${row.bucket} has ${row.n}/${MIN_BUCKET_N}`)
      .join(', ')
    return { state: 'insufficient', text: `Not enough data — ${need || 'no rows yet'}.` }
  }

  const delta = (b.r ?? 0) - (a.r ?? 0)

  if (Math.abs(delta) < margin) {
    return {
      state: 'no_separation',
      text: `No separation: ${low} ${a.r.toFixed(2)}R vs ${high} ${b.r.toFixed(2)}R. The definition is wrong, not the trades.`,
    }
  }

  return {
    state: 'separated',
    text: `Separation of ${delta.toFixed(2)}R between ${low} and ${high} (n=${a.n}/${b.n}). Screen only — not a significance test.`,
  }
}

/**
 * The whole report.
 *
 * @param {object} input
 * @param {object[]} input.trades live trades, already scoped by the caller
 * @param {Array<{date: string, snapshot: object}>} input.snapshots
 * @param {Array<{date: string, value: number}>} input.closes NDX daily closes
 */
export function validationReport({ trades = [], snapshots = [], closes = [] }) {
  const stdvVol = splitBy(trades, 'STDV', 'vol_regime')
  const mmBias = splitBy(trades, 'MM', 'regime_bias')

  return {
    gating_enabled: GATING_ENABLED,
    calibration: barCalibration(snapshots, closes),
    splits: {
      stdv_vol: stdvVol,
      stdv_bias: splitBy(trades, 'STDV', 'regime_bias'),
      mm_vol: splitBy(trades, 'MM', 'vol_regime'),
      mm_bias: mmBias,
    },
    verdicts: {
      // The spec's two named tests: does hostile hurt STDV, and does the bar
      // separate MM's continuation trades?
      stdv_vol: verdictFor(stdvVol, { low: 'hostile', high: 'calm' }),
      mm_bias: verdictFor(mmBias, { low: 'bear', high: 'bull' }),
    },
  }
}
