/**
 * Everything the Statistics view displays, computed from the trades the journal
 * already loads. Pure: no Supabase, no DOM, no new columns.
 *
 * A third stats module alongside `journal/stats.js` and `domain/trade-stats.js`
 * needs justifying. It exists because this one answers to a *page* rather than
 * a header strip or a model prompt: it returns grouped blocks (extremes,
 * averages, a cumulative curve, breakdowns) that neither of the others has a
 * use for, and it keeps FlowJournal's exact definitions so the two apps agree
 * on the same numbers — see the notes on each block below.
 *
 * Adding a block means adding one key to the returned object and one renderer
 * in `index.js`; nothing else has to change.
 */

import { discretionDelta, mechSplit } from '../domain/discretion.js'
import { pointStats } from '../domain/points.js'

const num = (v) => Number(v ?? 0)
const sum = (rows) => rows.reduce((a, t) => a + num(t.pnl), 0)
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

/**
 * FlowJournal counts winners and losers across *all* trades but breakeven only
 * among closed ones (trading-journal/index.html renderStats), so an Open trade
 * sitting at exactly 0 is not counted as breakeven. Kept as-is: the two apps
 * show these totals side by side.
 */
function totals(trades) {
  const wins = trades.filter((t) => num(t.pnl) > 0)
  const losses = trades.filter((t) => num(t.pnl) < 0)
  const breakeven = trades.filter((t) => num(t.pnl) === 0 && t.status !== 'Open')

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
  }
}

function extremes(trades) {
  const pnls = trades.map((t) => num(t.pnl))
  return {
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
  }
}

/**
 * `avgRr` reads the recorded `rr` column, not pnl/risk. Those are different
 * measurements — `rr` is the reward-to-risk the trade was *planned* at — and
 * `journal/stats.js` deliberately reports the realised one instead. Zero means
 * "not recorded" on this table, so it is excluded rather than averaged in.
 */
function averages(trades) {
  const winPnls = trades.map((t) => num(t.pnl)).filter((p) => p > 0)
  const lossPnls = trades.map((t) => num(t.pnl)).filter((p) => p < 0)
  const grossWin = winPnls.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0))

  return {
    avgWinner: mean(winPnls),
    avgLoser: mean(lossPnls),
    avgRr: mean(trades.map((t) => num(t.rr)).filter((r) => r > 0)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  }
}

/**
 * Running total in chronological order, oldest first — one point per trade.
 * `date` is text in `YYYY-MM-DDTHH:mm` form, so string order is time order.
 */
function curve(trades) {
  const chronological = [...trades].sort((a, b) =>
    String(a.date ?? '').localeCompare(String(b.date ?? ''))
  )

  let running = 0
  return chronological.map((t) => {
    running += num(t.pnl)
    return { num: t.num, pnl: num(t.pnl), cumulative: running }
  })
}

function group(trades, rows) {
  return rows.map(({ key, label }) => {
    const members = trades.filter((t) => t[key.field] === key.value)
    const wins = members.filter((t) => num(t.pnl) > 0).length
    return {
      label,
      count: members.length,
      winRate: members.length ? Math.round((wins / members.length) * 100) : null,
      pnl: sum(members),
    }
  })
}

const DIRECTIONS = ['Long', 'Short']

/** Preferred display order; anything else the table holds is appended after. */
const KNOWN_STATUSES = ['TP', 'SL', 'BE', 'TP1+BE', 'Open']

/**
 * Statuses are listed from the data rather than hardcoded, so a status added to
 * the form later shows up here without a change. Known ones keep their order.
 */
function statusesPresent(trades) {
  const present = new Set(trades.map((t) => t.status).filter(Boolean))
  const known = KNOWN_STATUSES.filter((s) => present.has(s))
  const extra = [...present].filter((s) => !KNOWN_STATUSES.includes(s)).sort()
  return [...known, ...extra]
}

/**
 * Computes the page.
 *
 * @param {object[]} trades executed trades only — vetoes and backtest entries
 *   are filtered out by the caller, because every block above is a P&L block.
 * @param {object[]} audited the same set *plus* vetoes, for the discretion
 *   block alone. A veto is a decision with an R of exactly 0, so it belongs in
 *   the discretion numbers and nowhere else on this page. Defaults to `trades`,
 *   which is the correct degenerate answer when there are no vetoes.
 */
export function computeStatistics(trades = [], audited = trades) {
  return {
    totals: totals(trades),
    extremes: extremes(trades),
    averages: averages(trades),
    curve: curve(trades),
    points: pointStats(trades),
    discretion: discretionDelta(audited),
    mech: mechSplit(audited),
    byDirection: group(
      trades,
      DIRECTIONS.map((d) => ({ key: { field: 'type', value: d }, label: d }))
    ),
    byStatus: group(
      trades,
      statusesPresent(trades).map((s) => ({ key: { field: 'status', value: s }, label: s }))
    ),
  }
}
