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
 * Bar calibration used to live here too — one point per session, snapshots
 * against NDX closes, filling whether or not you traded. It is gone, and not
 * because it was wrong: `scripts/backtest.mjs` now answers exactly that question
 * over 2,582 point-in-time sessions instead of the sixty this could accumulate
 * in three months. Keeping a slower, noisier copy of a settled question would
 * only invite reading a thin sample as a result.
 *
 * What is left needs fills *per bucket*, which is far slower, and `hostile` may
 * take a year or a shock to populate at all.
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

/**
 * The standing environment, and the question this report exists to ask now.
 *
 * The directional bar was replayed over 2,582 point-in-time sessions and
 * separated nothing — bull-minus-bear came to −2.3bps [−12.3, +8.0], with the
 * two halves of the sample disagreeing in sign. That question is settled
 * against the index, and no number of forward sessions here would settle it
 * better.
 *
 * What the index cannot answer is whether the environment sorts *your setups*.
 * You trade intraday SPM and MM; the replay measured close-to-close on NDX.
 * Those can legitimately diverge, and the journal is the only place the
 * difference can ever show up. That test needs trade count, not calendar days,
 * so it starts now and fills as you trade.
 */
export const ENVIRONMENT_BUCKETS = ['headwind', 'mixed', 'tailwind']
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
/**
 * How each stamped column is bucketed, and how a trade's value is read from it.
 *
 * A table rather than a chain of conditionals, because the previous shape —
 * "vol_regime, else treat it as the bar" — silently mis-bucketed the moment a
 * third column arrived: environment values were matched against bear/neutral/
 * bull, every trade fell outside all three, and the split rendered as three
 * empty rows next to a non-zero total. Nothing threw.
 *
 * Adding a column here means adding a row here.
 */
const SPLITS = {
  vol_regime: { buckets: VOL_BUCKETS, valueOf: (t) => t?.vol_regime ?? null },
  regime_bias: { buckets: BIAS_BUCKETS, valueOf: (t) => BIAS_GROUPS[t?.regime_bias] ?? null },
  macro_environment: {
    buckets: ENVIRONMENT_BUCKETS,
    valueOf: (t) => t?.macro_environment ?? null,
  },
}

export function splitBy(trades, model, key) {
  const scoped = (trades ?? []).filter((t) => (t?.model ?? null) === model)

  const split = SPLITS[key]
  if (!split) throw new Error(`no bucket definition for ${key}`)

  const rows = split.buckets.map((bucket) => ({
    bucket,
    ...bucketStats(scoped.filter((t) => split.valueOf(t) === bucket)),
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
 */
export function validationReport({ trades = [] }) {
  const stdvVol = splitBy(trades, 'STDV', 'vol_regime')
  const mmBias = splitBy(trades, 'MM', 'regime_bias')
  const stdvEnv = splitBy(trades, 'STDV', 'macro_environment')
  const mmEnv = splitBy(trades, 'MM', 'macro_environment')

  return {
    gating_enabled: GATING_ENABLED,
    splits: {
      stdv_vol: stdvVol,
      stdv_bias: splitBy(trades, 'STDV', 'regime_bias'),
      stdv_env: stdvEnv,
      mm_vol: splitBy(trades, 'MM', 'vol_regime'),
      mm_bias: mmBias,
      mm_env: mmEnv,
    },
    verdicts: {
      // The spec's original two: does hostile hurt STDV, and does the bar
      // separate MM's continuation trades? The second is kept because the
      // column is stamped anyway and measuring costs nothing — but mac no
      // longer *asserts* it, which is the distinction that matters.
      stdv_vol: verdictFor(stdvVol, { low: 'hostile', high: 'calm' }),
      mm_bias: verdictFor(mmBias, { low: 'bear', high: 'bull' }),

      // The new one, and the reason this report still exists.
      stdv_env: verdictFor(stdvEnv, { low: 'headwind', high: 'tailwind' }),
      mm_env: verdictFor(mmEnv, { low: 'headwind', high: 'tailwind' }),
    },
  }
}
