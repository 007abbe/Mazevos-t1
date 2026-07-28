import { listTrades } from './trades.js'
import { computeStats, fmtMoney, fmtNum } from './stats.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const statTile = (label, value, cls = '') =>
  `<div class="stat"><span class="stat-label">${label}</span><b class="${cls}">${value}</b></div>`

function renderStats(stats) {
  const pnlClass = stats.netPnl >= 0 ? 'ok' : 'bad'
  return `
    <div class="stats">
      ${statTile('Trades', stats.count)}
      ${statTile('Win rate', `${stats.winRate}%`)}
      ${statTile('Net P&amp;L', fmtMoney(stats.netPnl), pnlClass)}
      ${statTile('Profit factor', fmtNum(stats.profitFactor))}
      ${statTile('Avg win', fmtMoney(stats.avgWin), 'ok')}
      ${statTile('Avg loss', fmtMoney(-stats.avgLoss), 'bad')}
      ${statTile('Avg R', fmtNum(stats.avgR))}
    </div>
  `
}

function renderRows(trades) {
  return trades
    .slice(0, 50)
    .map((t) => {
      const pnl = Number(t.pnl ?? 0)
      return `
        <tr>
          <td class="mono">${esc(t.date ?? '')}</td>
          <td>${esc(t.status ?? '')}</td>
          <td class="mono num">${esc(t.risk ?? '')}</td>
          <td class="mono num ${pnl >= 0 ? 'ok' : 'bad'}">${fmtMoney(pnl)}</td>
        </tr>
      `
    })
    .join('')
}

/** Renders the read-only journal into `el`. */
export async function renderJournal(el) {
  el.innerHTML = `<p class="muted">Loading trades…</p>`
  try {
    const trades = await listTrades()

    if (!trades.length) {
      el.innerHTML = `<p class="muted">No trades visible for this account.</p>`
      return
    }

    el.innerHTML = `
      ${renderStats(computeStats(trades))}
      <table class="trades">
        <thead><tr><th>Date</th><th>Status</th><th class="num">Risk</th><th class="num">P&amp;L</th></tr></thead>
        <tbody>${renderRows(trades)}</tbody>
      </table>
      <p class="muted">Showing ${Math.min(trades.length, 50)} of ${trades.length} trades. Read-only.</p>
    `
  } catch (err) {
    el.innerHTML = `<p class="err">Could not load trades: ${esc(err.message)}</p>`
  }
}
