/**
 * Pure stats for the journal header tiles. No Supabase, no DOM.
 *
 * Deliberately separate from `src/domain/trade-stats.js`, which computes DOM's
 * Layer 1. They look similar — both count wins and losses and average R — but
 * they answer to different consumers and disagree everywhere it matters:
 *
 *   - this one summarises *closed* trades; Layer 1 aggregates whatever it was
 *     given, and reports `be` as a category rather than dropping it
 *   - this one rounds for display (integer win rate, raw floats); Layer 1
 *     rounds for a prompt (1dp, 2dp) and returns null where there is no
 *     measurement, because 0 would read to the model as a measured zero
 *   - this one has netPnl, profitFactor, avgWin and avgLoss, which DOM does not
 *     use; Layer 1 has rSample, insufficient and earlySignal, which the header
 *     has no use for
 *
 * Merging them would mean a shared function parameterised on rounding, null
 * policy and filtering — more machinery than the dozen lines it would save.
 * The real cost is elsewhere: Layer 1's output is stored in `dom_reports.stats`
 * and read by the model, so coupling it to these tiles would let a cosmetic
 * header tweak change what a past report can be audited against.
 *
 * Only `pnl` and `risk` are read here; both are used by the legacy dashboard
 * query, so they are known to exist on the production table.
 */

import { isRealTrade, isVeto } from '../domain/veto-vocab.js'

const num = (v) => Number(v ?? 0)

/**
 * Header tiles for a set of trades. Veto rows are dropped first and counted
 * separately.
 *
 * This is the enforcement point for the whole veto idea, not a display nicety.
 * A veto has no fill: its P&L is 0 and its risk is 0, so leaving it in would
 * add a row to `count`, a zero to the win-rate denominator, and nothing to
 * `netPnl` — a journal that logs its near-misses honestly would show a falling
 * win rate as a reward. `vetoes` is returned so the UI can still say how many
 * there were.
 */
export function computeStats(trades) {
  const vetoes = trades.filter(isVeto).length
  const taken = trades.filter(isRealTrade)
  const closed = taken.filter((t) => t.pnl !== null && t.pnl !== undefined)
  const wins = closed.filter((t) => num(t.pnl) > 0)
  const losses = closed.filter((t) => num(t.pnl) < 0)

  const sum = (rows) => rows.reduce((a, t) => a + num(t.pnl), 0)
  const grossWin = sum(wins)
  const grossLoss = Math.abs(sum(losses))

  // R-multiple, only over trades that recorded a non-zero risk.
  const withRisk = closed.filter((t) => num(t.risk) > 0)
  const totalR = withRisk.reduce((a, t) => a + num(t.pnl) / num(t.risk), 0)

  return {
    count: closed.length,
    vetoes,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    netPnl: sum(closed),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgR: withRisk.length ? totalR / withRisk.length : null,
  }
}

export const fmtMoney = (n) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export const fmtNum = (n, digits = 2) => (n === null ? '—' : n.toFixed(digits))
