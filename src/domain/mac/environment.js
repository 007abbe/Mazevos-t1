/**
 * The environment: the standing conditions, not the weather.
 *
 * Everything else in mac reads *changes* — a 20-day move in the 2Y, a 10-day
 * widening in credit, a vol spike. Changes are reactions, and a model built on
 * them can only ever tell you what has already happened. The backtest showed
 * that plainly: the one factor that separated anything (F7) is the market's own
 * reaction to a move that was already over, and its "hostile" flag arrives on
 * average 253bps *after* the drawdown.
 *
 * This module reads **levels** instead, and only two of them:
 *
 *   **The 10-year real yield.** NQ is a long-duration asset, so its multiple is
 *   arithmetically a function of the real discount rate. Not the direction the
 *   yield moved last month — the level it sits at. F3 already holds this series
 *   and reads only its 20-day change, which throws away the part that matters.
 *
 *   **Net liquidity.** Reserves less the Treasury's cash balance less the RRP:
 *   a stock set by policy and Treasury mechanics, exogenous to price, moving
 *   over quarters. The marginal bid for risk.
 *
 * Those two are the mechanism by which macro reaches a long-duration index at
 * all. Growth and inflation matter mostly *through* them, which is why they are
 * not votes here.
 *
 * **This is not a signal and it must never become one.** It has no forward test
 * behind it and it cannot get one: the unit of analysis is the environment, and
 * ten years holds four or five of those. Statistical validation is permanently
 * out of reach, so the standard is mechanism and descriptive accuracy. What it
 * is for is context — the same register as "we are above the value area".
 *
 * Everything here is pure.
 */

import { SERIES, asOf, netLiquiditySeries } from './factors.js'
import { confirm, memory } from './hysteresis.js'
import { isStale, lastDate, lastValue } from './fred.js'

/**
 * Where the 10-year real yield stops being a tailwind and starts being a brake.
 *
 * Anchored on estimates of the neutral real rate — r* sits around 0.5–1% in the
 * Laubach-Williams family, and a 10-year real yield carries a term premium on
 * top — not on anything fitted to NQ returns. Fitting them would make this a
 * (badly overfitted) signal, which is exactly what it must not be.
 *
 * The resulting history reads the way a macro desk would describe it: 2012-2019
 * accommodative to neutral, 2020-2021 deeply accommodative, 2023 onward
 * restrictive. That agreement is the test being applied here, and it is the only
 * one available.
 */
export const REAL_RATE_ACCOMMODATIVE = 0.5
export const REAL_RATE_RESTRICTIVE = 1.5

/**
 * What counts as the liquidity stock actually moving, per quarter.
 *
 * A hundred billion over thirteen weeks. Taken from the observed distribution —
 * quartiles sit near ±100bn — so roughly half of history reads flat and the
 * tails pick out the episodes a macro reader would name: QE3 at +260bn/quarter,
 * 2018-19 QT at −100bn, the 2020 expansion at +218bn, 2022 QT at −162bn.
 */
export const LIQUIDITY_MOVE_BN = 100
export const LIQUIDITY_WINDOW_WEEKS = 13

/**
 * How long a change has to hold before the environment is said to have changed.
 *
 * Ten sessions, which is far slower than any other hysteresis in mac. That is
 * the point: an environment that can flip in a week is not an environment, it is
 * a reaction wearing the word. If this label moves more than a few times a year
 * the thresholds are wrong.
 */
export const ENVIRONMENT_CONFIRMATIONS = 10

/** Real-yield stance, or null when the series cannot support a reading. */
export function realRateStance(series, today) {
  const tips = series[SERIES.DFII10.id] ?? []
  const level = lastValue(tips)

  if (level == null || isStale(tips, today, SERIES.DFII10.budgetDays)) {
    return { level, stance: null, stale: true }
  }

  const stance =
    level > REAL_RATE_RESTRICTIVE
      ? 'restrictive'
      : level < REAL_RATE_ACCOMMODATIVE
        ? 'accommodative'
        : 'neutral'

  return { level, stance, stale: false }
}

/** Net-liquidity stance over a quarter, or null when it cannot be read. */
export function liquidityStance(series, today) {
  const walcl = series[SERIES.WALCL.id] ?? []
  const netLiq = netLiquiditySeries(
    walcl,
    series[SERIES.WTREGEN.id] ?? [],
    series[SERIES.RRPONTSYD.id] ?? []
  )

  if (netLiq.length <= LIQUIDITY_WINDOW_WEEKS || isStale(walcl, today, SERIES.WALCL.budgetDays)) {
    return { level_bn: lastValue(netLiq), change_bn: null, stance: null, stale: true }
  }

  const now = netLiq[netLiq.length - 1]
  const then = netLiq[netLiq.length - 1 - LIQUIDITY_WINDOW_WEEKS]
  const change = now.value - then.value

  const stance =
    change > LIQUIDITY_MOVE_BN
      ? 'expanding'
      : change < -LIQUIDITY_MOVE_BN
        ? 'draining'
        : 'flat'

  return { level_bn: now.value, change_bn: change, stance, stale: false, as_of: now.date }
}

/**
 * The 2×2, as a single standing description.
 *
 * Only the corners are named. `mixed` is not a hedge — it is the honest reading
 * when the discount rate and the marginal bid disagree, which is most of the
 * time, and calling it something more decisive would be inventing information.
 */
export function standingOf(rates, liquidity) {
  if (!rates || !liquidity) return null
  if (rates === 'restrictive' && liquidity === 'draining') return 'headwind'
  if (rates === 'accommodative' && liquidity === 'expanding') return 'tailwind'
  return 'mixed'
}

/**
 * The standing description as a number, because that is what the shared
 * hysteresis speaks.
 *
 * `memory()` normalises `state` and `candidate` through `Number.isFinite`, so a
 * string label silently fails to accumulate a streak and the environment would
 * never publish at all. Encoding it here reuses the confirmation logic every
 * other factor is tested against rather than growing a second copy of it.
 *
 * **None of these may be 0.** An untouched memory starts at state 0, and
 * `confirm` short-circuits when the candidate already equals the state — so
 * encoding `mixed` as 0 meant a history that began mixed could never publish
 * anything. It read "not enough data" for three and a half years while the
 * inputs were perfectly healthy and the label flipped only eleven times.
 *
 * These are opaque codes, not a signed scale. The environment never enters
 * `bias_raw`, so there is no sum for a sign convention to serve.
 */
export const STANDING_CODES = { headwind: 1, mixed: 2, tailwind: 3 }
const STANDING_BY_CODE = { 1: 'headwind', 2: 'mixed', 3: 'tailwind' }

const STANDING_TEXT = {
  headwind: 'Headwind',
  tailwind: 'Tailwind',
  mixed: 'Mixed',
}

/**
 * The environment for `today`, with yesterday's carried forward through the
 * confirmation counter.
 *
 * @param {object} input
 * @param {Record<string, Array<{date: string, value: number}>>} input.series
 * @param {object} [input.prior] yesterday's `memory` block
 * @param {string} input.today
 */
export function environment({ series, prior, today }) {
  const rates = realRateStance(series, today)
  const liquidity = liquidityStance(series, today)

  const label = standingOf(rates.stance, liquidity.stance)
  const before = memory(prior)

  // The confirmation guards *changes*. On the very first reading there is no
  // established description to protect, so adopting the current one costs
  // nothing and waiting costs everything: mac runs once a day, so ten
  // confirmations would have meant a fortnight of "not enough data" on inputs
  // that were sitting right there, complete and fresh.
  //
  // Same asymmetry `confirm` already documents for F7 — immediate entering,
  // confirmed leaving.
  const settled =
    label == null
      ? { ...before, changed: false }
      : confirm({
          candidate: STANDING_CODES[label],
          prior: before,
          confirmations: ENVIRONMENT_CONFIRMATIONS,
          immediate: () => !before.published,
        })

  // `published` distinguishes "never established" from "established as mixed",
  // which the state alone cannot: an untouched memory reads 0 either way.
  const published = Boolean(before.published || settled.changed)
  const standing = published ? STANDING_BY_CODE[String(settled.state)] : null

  return {
    standing,
    standing_text: standing ? STANDING_TEXT[standing] : 'Not enough data',
    rates: { level: rates.level, stance: rates.stance },
    liquidity: {
      level_bn: liquidity.level_bn,
      change_bn: liquidity.change_bn,
      stance: liquidity.stance,
    },
    stale: [rates.stale ? SERIES.DFII10.id : null, liquidity.stale ? SERIES.WALCL.id : null].filter(
      Boolean
    ),
    note: describe(rates, liquidity, standing),
    memory: { ...settled, published },
  }
}

/**
 * The environment in one sentence, with the mechanism named rather than implied.
 *
 * It says what the conditions *are*, never what the index will do. The whole
 * point of separating this from the bar is that the bar made a directional claim
 * the evidence did not support; repeating it here in gentler words would give
 * back exactly what was removed.
 */
function describe(rates, liquidity, standing) {
  if (!standing) {
    // Two very different reasons the standing can be absent, and saying the
    // wrong one is worse than saying nothing: the card shows the inputs right
    // beside this line, so claiming they are missing when they are plainly
    // there reads as a broken panel rather than a settling one.
    const missing = [
      rates.stance == null ? 'real yield' : null,
      liquidity.stance == null ? 'net liquidity' : null,
    ].filter(Boolean)

    return missing.length
      ? `Environment unavailable — ${missing.join(' and ')} missing or stale.`
      : 'Environment still settling — a change has to hold before it is published.'
  }

  const level = rates.level == null ? '—' : `${rates.level.toFixed(2)}%`
  const change =
    liquidity.change_bn == null
      ? '—'
      : `${liquidity.change_bn >= 0 ? '+' : '−'}$${Math.abs(Math.round(liquidity.change_bn))}bn`

  const rateClause =
    rates.stance === 'restrictive'
      ? `10y real at ${level} is restrictive — a standing brake on long-duration multiples`
      : rates.stance === 'accommodative'
        ? `10y real at ${level} is accommodative — no discount-rate brake`
        : `10y real at ${level} is near neutral`

  const liqClause =
    liquidity.stance === 'draining'
      ? `net liquidity ${change} over the quarter — the marginal bid is shrinking`
      : liquidity.stance === 'expanding'
        ? `net liquidity ${change} over the quarter — the marginal bid is growing`
        : `net liquidity ${change} over the quarter — broadly flat`

  const tail =
    standing === 'headwind'
      ? 'Both channels lean against risk. Context only — this is not a directional call.'
      : standing === 'tailwind'
        ? 'Both channels lean toward risk. Context only — this is not a directional call.'
        : 'The two channels disagree, so the environment gives no clear lean.'

  return `${rateClause}; ${liqClause}. ${tail}`
}
