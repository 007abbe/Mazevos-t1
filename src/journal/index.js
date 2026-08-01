import { listTrades } from './trades.js'
import { computeStats, fmtMoney, fmtNum } from './stats.js'
import { openTradeForm } from './form.js'
import { applyFilters, tradeLabel, SORTS, STATUSES, DIRECTIONS, NO_FILTERS } from './filters.js'
import { publishSummary } from '../lib/summary.js'
import { esc, explainFailure } from '../lib/ui-text.js'

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

const option = (value, label, selected) =>
  `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`

function renderFilters(filters) {
  return `
    <div class="filters">
      <input class="search-box" type="search" id="f-search" placeholder="Search ticker, thesis…"
             value="${esc(filters.search)}" aria-label="Search trades">
      <select class="filter-select" id="f-status" aria-label="Filter by status">
        ${option('', 'All statuses', filters.status)}
        ${STATUSES.map((s) => option(s, s, filters.status)).join('')}
      </select>
      <select class="filter-select" id="f-direction" aria-label="Filter by direction">
        ${option('', 'All directions', filters.direction)}
        ${DIRECTIONS.map((d) => option(d, d, filters.direction)).join('')}
      </select>
      <select class="filter-select" id="f-sort" aria-label="Sort trades">
        ${SORTS.map((s) => option(s.value, s.label, filters.sort)).join('')}
      </select>
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
          <td class="mono">${esc(tradeLabel(t))}</td>
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

function renderTable(visible, total) {
  if (!total) return `<p class="muted">No trades yet. Log your first one.</p>`
  if (!visible.length) return `<p class="muted">No trades match these filters.</p>`

  return `
    <div class="table-wrap">
      <table class="trades">
        <thead><tr>
          <th>Trade</th><th>Date</th><th>Dir</th><th>Status</th><th>Setup</th>
          <th class="num">Risk</th><th class="num">P&amp;L</th>
        </tr></thead>
        <tbody>${renderRows(visible)}</tbody>
      </table>
    </div>
    <p class="muted">Showing ${Math.min(visible.length, 50)} of ${visible.length}${
      visible.length === total ? '' : ` (${total} total)`
    }. Click a row to edit.</p>
  `
}

/**
 * Renders the journal into `el`.
 *
 * Filtering is local state: `listTrades` runs once per mount, and every filter
 * change re-renders the table from the array already in memory.
 */
export async function renderJournal(el, { header } = {}) {
  el.innerHTML = `<p class="muted">Loading trades…</p>`

  let trades
  try {
    trades = await listTrades()
  } catch (err) {
    el.innerHTML = `<p class="err">${esc(explainFailure(err, { prefix: 'Could not load trades' }))}</p>`
    return
  }

  publishSummary(computeStats(trades))

  const reload = () => renderJournal(el, { header })
  const filters = { ...NO_FILTERS }

  // The shell owns the topbar; the view owns what goes in it. Clearing first
  // keeps a reload from stacking a second button.
  if (header) {
    header.innerHTML = `<button type="button" class="btn-add" data-act="new">+ Log trade</button>`
    header
      .querySelector('[data-act="new"]')
      .addEventListener('click', () => openTradeForm({ onSaved: reload }))
  }

  el.innerHTML = `
    ${renderStats(computeStats(trades))}
    ${renderFilters(filters)}
    <div id="trade-table"></div>
  `

  const table = el.querySelector('#trade-table')

  const paint = () => {
    const visible = applyFilters(trades, filters)
    table.innerHTML = renderTable(visible, trades.length)

    const openRow = (row) =>
      openTradeForm({ trade: trades.find((t) => t.id === row.dataset.id), onSaved: reload })

    table.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => openRow(row))
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openRow(row)
        }
      })
    })
  }

  const bind = (id, key, event) =>
    el.querySelector(id).addEventListener(event, (e) => {
      filters[key] = e.target.value
      paint()
    })

  bind('#f-search', 'search', 'input')
  bind('#f-status', 'status', 'change')
  bind('#f-direction', 'direction', 'change')
  bind('#f-sort', 'sort', 'change')

  paint()
}
