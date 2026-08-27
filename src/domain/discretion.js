import { isVeto } from './veto-vocab.js'

/**
 * The discretion delta: does your judgement pay?
 *
 * One number. Take every row where a strict mechanical SPM/MM *would* have
 * fired, average the R you actually got, average the R the mechanical version
 * would have got, and subtract. Positive means your departures from the model
 * earned their keep. Negative means the model was right and you were expensive.
 *
 * Agent-agnostic and UI-free, like the rest of src/domain — the journal renders
 * this, DOM can reason about it, neither defines it.
 */

/**
 * The signed R a row actually returned.
 *
 * A veto returns exactly 0R, and that is the whole point of including vetoes
 * here: if the mechanical model fired, you talked yourself out of it, and it
 * would have paid +1.8R, then your discretion cost 1.8R on that row. Scoring a
 * veto as "no data" would quietly delete your worst decisions from the average
 * and leave the delta flattering.
 *
 * A real trade needs a recorded risk to have an R at all — `rr` is not used,
 * because the form stores it unsigned (|P&L| ÷ risk), so a full loss and a full
 * win are the same number there.
 */
export function actualR(trade) {
  if (isVeto(trade)) return 0

  const risk = Number(trade?.risk ?? 0)
  if (!(risk > 0)) return null

  const pnl = Number(trade?.pnl ?? 0)
  return Number.isFinite(pnl) ? pnl / risk : null
}

const mechR = (trade) => {
  const r = trade?.mech_counterfactual_r
  if (r === null || r === undefined || r === '') return null
  const n = Number(r)
  return Number.isFinite(n) ? n : null
}

/**
 * Rows the delta can be computed over: the mechanical model fired, you recorded
 * what it would have returned, and the row has an actual R to compare it to.
 *
 * 'partial' and 'no' are excluded on purpose. Without a mechanical trigger
 * there is no baseline, and averaging against a baseline that did not exist is
 * how you get a number that always agrees with you.
 */
export const isDiscretionComparable = (t) =>
  t?.mech_trigger === 'yes' && mechR(t) !== null && actualR(t) !== null

const mean = (values) => values.reduce((a, v) => a + v, 0) / values.length

/**
 * @param {object[]} trades any mix of trades and vetoes; unqualified rows are
 *   skipped rather than counted as zero
 * @returns {{n: number, avgActualR: number|null, avgMechR: number|null,
 *   delta: number|null, tagged: number}} `n` is the sample the delta rests on
 *   and should be shown with it — a delta over two rows is an anecdote.
 *   `tagged` is how many rows answered mech_trigger = 'yes' at all, so the UI
 *   can tell "you have not logged the counterfactuals" apart from "the
 *   mechanical model rarely fires".
 */
export function discretionDelta(trades = []) {
  const tagged = trades.filter((t) => t?.mech_trigger === 'yes')
  const rows = tagged.filter(isDiscretionComparable)

  if (!rows.length) {
    return { n: 0, avgActualR: null, avgMechR: null, delta: null, tagged: tagged.length }
  }

  const avgActualR = mean(rows.map(actualR))
  const avgMechR = mean(rows.map(mechR))

  return {
    n: rows.length,
    avgActualR,
    avgMechR,
    delta: avgActualR - avgMechR,
    tagged: tagged.length,
  }
}

/**
 * Expectancy in R: what one entry from this set returns on average.
 *
 * Rows with no measurable R are skipped rather than counted as zero — a trade
 * that never recorded its risk has an unknown R, and folding it in as a scratch
 * would pull every expectancy on the page toward the middle.
 */
export function expectancy(trades = []) {
  const rs = trades.map(actualR).filter((r) => r !== null)
  return { n: rs.length, r: rs.length ? mean(rs) : null }
}

/**
 * Expectancy split by whether the mechanical model fired, as four disjoint
 * groups that together cover every row.
 *
 * `deviation` is the one worth staring at: entries you took when a strict
 * mechanical run would *not* have. It is reported on its own and never folded
 * into a headline expectancy, because blending is exactly what hides it — a
 * book of good mechanical trades will happily carry a bleeding discretionary
 * habit inside one flattering average.
 *
 * `untagged` exists so the page can say how much of the journal has not been
 * audited yet. Without it, a mostly-unanswered column would be indistinguishable
 * from a mechanical model that rarely fires.
 */
export function mechSplit(trades = []) {
  const withTrigger = (value) => trades.filter((t) => (t?.mech_trigger ?? null) === value)

  return {
    fired: expectancy(withTrigger('yes')),
    deviation: expectancy(withTrigger('no')),
    partial: expectancy(withTrigger('partial')),
    untagged: expectancy(withTrigger(null)),
  }
}

/** The deviation group on its own, named for what it measures. */
export const deviationCost = (trades = []) => mechSplit(trades).deviation
