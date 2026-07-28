import { listTrades } from './trades.js'
import { computeStats, fmtMoney, fmtNum } from './stats.js'
import { openTradeForm } from './form.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const statTile = (label, value, cls = '') =>
  `<div class="stat"><span class="stat-label">${label}</span><b class="${cls}">${value}</b></div>`

function renderStats(stats) {
  return `
    <div class="stats">
      ${statTile('Trades', stats.count)}
      ${statTile('Win rate', `${stats.winRate}%`)}
      ${statTile('Net P&amp;L', fmtMoney(stats.netPnl), stats.netPnl >= 0 ? 'ok' : 'bad')}
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
        <tr data-id="${esc(t.id)}" tabindex="0">
          <td class="mono">${esc(t.date ?? '')}</td>
          <td>${esc(t.type ?? '')}</td>
          <td>${esc(t.status ?? '')}</td>
          <td>${esc(t.setup_type ?? '')}</td>
          <td class="mono num">${esc(t.risk ?? '')}</td>
          <td class="mono num ${pnl >= 0 ? 'ok' : 'bad'}">${fmtMoney(pnl)}</td>
        </tr>
      `
    })
    .join('')
}

/** Renders the journal into `el`. */
export async function renderJournal(el) {
  el.innerHTML = `<p class="muted">Loading trades…</p>`

  let trades
  try {
    trades = await listTrades()
  } catch (err) {
    el.innerHTML = `<p class="err">Could not load trades: ${esc(err.message)}</p>`
    return
  }

  const reload = () => renderJournal(el)

  el.innerHTML = `
    <div class="journal-head">
      ${renderStats(computeStats(trades))}
      <button data-act="new">Log trade</button>
    </div>
    ${
      trades.length
        ? `<table class="trades">
             <thead><tr><th>Date</th><th>Dir</th><th>Status</th><th>Setup</th><th class="num">Risk</th><th class="num">P&amp;L</th></tr></thead>
             <tbody>${renderRows(trades)}</tbody>
           </table>
           <p class="muted">Showing ${Math.min(trades.length, 50)} of ${trades.length}. Click a row to edit.</p>`
        : `<p class="muted">No trades yet. Log your first one.</p>`
    }
  `

  el.querySelector('[data-act="new"]').addEventListener('click', () =>
    openTradeForm({ onSaved: reload })
  )

  const openRow = (row) =>
    openTradeForm({ trade: trades.find((t) => t.id === row.dataset.id), onSaved: reload })

  el.querySelectorAll('tr[data-id]').forEach((row) => {
    row.addEventListener('click', () => openRow(row))
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openRow(row)
      }
    })
  })
}
