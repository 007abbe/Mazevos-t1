/**
 * Composition: factor states in, one bar out.
 *
 * The bar is a *normalised lean, not a probability*. Two multipliers pull it
 * toward 50 — conviction, so a loud bias that nothing agrees with reads as a
 * lean rather than a call, and vol, because macro signals are less reliable
 * inside a vol spike. The clamp at 10/90 is the third: mac never claims
 * certainty about tomorrow.
 *
 * Until the validation phase has 60–100 logged sessions, nothing here may be
 * worded as a probability. "65% bull" means the lean scored 65 on this scale,
 * not that 65% of such days closed green — which is exactly what phase 4 exists
 * to measure and why the wording stays "may have a tailwind".
 */

import { VOL_REGIMES } from './factors.js'
import { daysBetween } from './fred.js'

/** The six numeric factors, in the order they are summed and displayed. */
export const FACTOR_KEYS = ['growth', 'inflation', 'rates', 'liquidity', 'credit', 'dollar']

export const CONVICTION_MULT = { low: 0.6, medium: 0.8, high: 1.0 }
export const VOL_MULT = { calm: 1.0, elevated: 0.85, hostile: 0.6 }

/** How far one point of `bias_raw` moves the bar before the multipliers. */
export const BAR_SCALE = 6
export const BAR_FLOOR = 10
export const BAR_CEILING = 90

/** Sessions a new regime label must hold before it is published as the label. */
export const REGIME_CONFIRMATIONS = 3

/** Factors that must flip on one day to publish a new label immediately. */
export const REGIME_SHOCK_FACTORS = 2

const CONVICTION_ORDER = ['low', 'medium', 'high']

/**
 * The growth/inflation quadrant.
 *
 * Note the sign convention: these are mac factor states, where positive is a
 * tailwind for NQ. So "inflation ≥ 0" means inflation is *behaving* — that is
 * the Goldilocks corner — and "inflation < 0" means it is hot. Reading the
 * quadrant names against raw CPI rather than against the factor state inverts
 * two of the four.
 */
export function quadrant(growth, inflation) {
  if (growth == null || inflation == null) return null
  if (growth >= 0) return inflation >= 0 ? 'goldilocks' : 'overheating'
  return inflation >= 0 ? 'slowdown' : 'stagflation_adjacent'
}

export const QUADRANT_LABELS = {
  goldilocks: 'Goldilocks',
  overheating: 'Overheating',
  stagflation_adjacent: 'Stagflation-adjacent',
  slowdown: 'Slowdown / recession',
}

/** Sum of the six factor states. Credit can reach −4, so the range is asymmetric. */
export function biasRaw(states) {
  return FACTOR_KEYS.reduce((sum, key) => sum + (states[key]?.state ?? 0), 0)
}

/**
 * How many of the six actually agree with the sign of the sum.
 *
 * A bias of −3 built from one factor at −3 and five at zero is a different
 * animal from one built from three factors at −1 each, and this is what tells
 * them apart. Factors at zero abstain; factors that disagree are simply not
 * counted, because they have already been paid for inside `bias_raw`.
 */
export function conviction(states, bias, volRegime) {
  const sign = Math.sign(bias)

  const agreeing = sign === 0
    ? 0
    : FACTOR_KEYS.filter((key) => {
        const state = states[key]?.state ?? 0
        return Math.abs(state) >= 1 && Math.sign(state) === sign
      }).length

  let level = agreeing >= 5 ? 'high' : agreeing >= 3 ? 'medium' : 'low'

  // Macro signals are less reliable in a vol spike, so the same agreement buys
  // less conviction. One notch, not two — hostile already costs 40% via VOL_MULT.
  if (volRegime === 'hostile') {
    level = CONVICTION_ORDER[Math.max(0, CONVICTION_ORDER.indexOf(level) - 1)]
  }

  return { level, agreeing }
}

/** Bar buckets, low to high. First match wins, so the order is the definition. */
const LABELS = [
  { max: 20, key: 'strong_bear', text: 'strong bear' },
  { max: 35, key: 'bear', text: 'bear' },
  { max: 45, key: 'leaning_bear', text: 'leaning bear' },
  { max: 54, key: 'neutral', text: 'neutral' },
  { max: 64, key: 'leaning_bull', text: 'leaning bull' },
  { max: 79, key: 'bull', text: 'bull' },
  { max: 100, key: 'strong_bull', text: 'strong bull' },
]

export function barLabel(bullPct) {
  return LABELS.find((entry) => bullPct <= entry.max) ?? LABELS[LABELS.length - 1]
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/**
 * The headline bar.
 *
 * @param {object} input
 * @param {number} input.bias `bias_raw`
 * @param {'low'|'medium'|'high'} input.convictionLevel
 * @param {'calm'|'elevated'|'hostile'} input.volRegime
 * @returns {{bull_pct: number, bear_pct: number, label: string, label_text: string,
 *   sentence: string}}
 */
export function bar({ bias, convictionLevel, volRegime }) {
  const raw = 50 + bias * BAR_SCALE * (CONVICTION_MULT[convictionLevel] ?? 0.6) * (VOL_MULT[volRegime] ?? 1)
  const bullPct = Math.round(clamp(raw, BAR_FLOOR, BAR_CEILING))
  const bearPct = 100 - bullPct
  const label = barLabel(bullPct)

  return {
    bull_pct: bullPct,
    bear_pct: bearPct,
    label: label.key,
    label_text: label.text,
    sentence: sentence({ bullPct, bearPct, label, convictionLevel, volRegime }),
  }
}

/**
 * The one line under the bar. Deterministic — the LLM never writes this, it
 * only quotes it, which is what keeps Finski's no-direction rule intact while
 * still letting a directional read reach the brief.
 */
function sentence({ bullPct, bearPct, label, convictionLevel, volRegime }) {
  if (label.key === 'neutral') {
    return 'Neutral — no macro sponsorship either way; trade the microstructure, normal size.'
  }

  const side = bullPct > 54 ? 'Longs' : 'Shorts'
  const caveat = convictionLevel === 'low' ? ', but conviction is low' : ''
  const vol =
    volRegime === 'calm' ? '' : `; vol regime ${volRegime}, size capped`

  return `${bullPct}% bull / ${bearPct}% bear — ${label.text}. ${side} may have a tailwind${caveat}${vol}.`
}

/**
 * Regime persistence.
 *
 * The label is recomputed every day but only *published* once it has held for
 * three sessions. Without this the card would announce a new regime on any day
 * a single factor grazed a threshold, and "regime" would mean nothing more than
 * "today's reading". The exception is a day on which two or more factors flip
 * at once: that is a genuine repricing, and making it wait three days to be
 * named would be the failure this rule is meant to prevent.
 *
 * @param {object} input
 * @param {string} input.label today's computed label
 * @param {object|null} input.prior yesterday's `regime` block
 * @param {number} input.factorsChanged how many factors flipped state today
 * @param {string} input.today `YYYY-MM-DD`
 */
export function publishRegime({ label, prior, factorsChanged, today }) {
  const before = prior ?? {}

  if (!before.label) {
    return { label, since: today, age_days: 0, pending: null, pending_streak: 0 }
  }

  const age = daysBetween(before.since, today) ?? 0

  if (label === before.label) {
    return {
      label,
      since: before.since,
      age_days: Math.max(0, age),
      pending: null,
      pending_streak: 0,
    }
  }

  const shock = factorsChanged >= REGIME_SHOCK_FACTORS
  const streak = label === before.pending ? (before.pending_streak ?? 0) + 1 : 1

  if (shock || streak >= REGIME_CONFIRMATIONS) {
    return { label, since: today, age_days: 0, pending: null, pending_streak: 0 }
  }

  return {
    label: before.label,
    since: before.since,
    age_days: Math.max(0, age),
    pending: label,
    pending_streak: streak,
  }
}

/**
 * The two lists that answer "X may cause Y".
 *
 * Every factor carrying a state emits its own mechanism, so the explanation is
 * generated from the same object that produced the number rather than written
 * separately and left to drift out of agreement with it.
 */
export function windLists(factors) {
  const headwinds = []
  const tailwinds = []

  for (const key of FACTOR_KEYS) {
    const factor = factors[key]
    if (!factor || Math.abs(factor.state) < 1) continue
    ;(factor.state < 0 ? headwinds : tailwinds).push(factor.note)
  }

  return { headwinds, tailwinds }
}

/** How near a flip has to be to be worth watching. */
export const WATCH_HORIZON_DAYS = 5

/**
 * Flip conditions landing inside the next five sessions.
 *
 * A factor whose next input is a month away is not something to watch today,
 * and listing it every day would train you to skip the list.
 */
export function watchList(factors, today) {
  const out = []

  for (const key of FACTOR_KEYS) {
    const factor = factors[key]
    const when = factor?.flip?.when
    if (!when) continue

    const days = daysBetween(today, when)
    if (days == null || days < 0 || days > WATCH_HORIZON_DAYS) continue

    out.push(`watch: ${key} input on ${when} — ${factor.flip.what}`)
  }

  return out
}

/** Appends today's reading to the ten-session bar history, oldest first. */
export function barHistory(prior, bullPct, limit = 10) {
  const before = Array.isArray(prior) ? prior.filter((n) => Number.isFinite(n)) : []
  return [...before, bullPct].slice(-limit)
}

/** Guards against a vol regime that storage or a partial read left unusable. */
export const normaliseVolRegime = (regime) =>
  VOL_REGIMES.includes(regime) ? regime : 'elevated'
