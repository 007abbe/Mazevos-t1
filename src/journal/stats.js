/**
 * Pure stats over a list of trade rows. No Supabase, no DOM — safe to move to
 * src/domain/ if these grow into real trading logic.
 *
 * Only `pnl` and `risk` are read here; both are used by the legacy dashboard
 * query, so they are known to exist on the production table.
 */

const num = (v) => Number(v ?? 0)

export function computeStats(trades) {
  const closed = trades.filter((t) => t.pnl !== null && t.pnl !== undefined)
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
