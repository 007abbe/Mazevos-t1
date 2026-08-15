import { listTrades } from './trades.js'
import { listAccounts, rememberedFilter, rememberFilter } from './accounts.js'
import { openAccountsModal } from './accounts-ui.js'
import { computeStats, fmtMoney, fmtNum } from './stats.js'
import { openTradeForm } from './form.js'
import {
  applyFilters, byAccount, tradeLabel, SORTS, STATUSES, DIRECTIONS, NO_FILTERS, UNASSIGNED,
} from './filters.js'
import { publishSummary } from '../lib/summary.js'
import { directionBadge, statusBadge } from '../lib/trade-badges.js'
import { accountName } from '../lib/account-badges.js'
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

function renderFilters(filters, accounts) {
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
      <select class="filter-select" id="f-account" aria-label="Filter by account">
        ${option('', 'All accounts', filters.account)}
        ${accounts.map((a) => option(a.id, a.name, filters.account)).join('')}
        ${option(UNASSIGNED, 'Unassigned', filters.account)}
      </select>
      <button type="button" class="ghost btn-accounts" data-act="accounts">Accounts</button>
    </div>
  `
}

/** Risk as FlowJournal shows it: whole dollars, or an em dash when unrecorded. */
const fmtRisk = (risk) => {
  const n = Number(risk ?? 0)
  return n > 0 ? `$${n.toFixed(0)}` : '—'
}

/**
 * The setup column, whichever model the trade belongs to. STDV keeps A/B/C in
 * `setup_type`; MM keeps its own four in `mm_setup`. A trade logged before the
 * model switch existed has no `model` and is STDV.
 */
const tradeSetup = (t) => (t.model === 'MM' ? t.mm_setup : t.setup_type) ?? ''

function renderRows(trades, accountsById) {
  return trades
    .slice(0, 50)
    .map((t) => {
      const pnl = Number(t.pnl ?? 0)
      return `
        <tr data-id="${esc(t.id)}" tabindex="0">
          <td class="mono">${esc(tradeLabel(t))}</td>
          <td class="mono">${esc(t.date ?? '')}</td>
          <td>${directionBadge(t.type)}</td>
          <td>${statusBadge(t.status)}</td>
          <td class="acct-cell">${accountName(accountsById.get(t.account_id))}</td>
          <td>${esc(tradeSetup(t))}</td>
          <td class="num risk-cell">${fmtRisk(t.risk)}</td>
          <td class="num ${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtMoney(pnl)}</td>
        </tr>
      `
    })
    .join('')
}

function renderTable(visible, total, accountsById) {
  if (!total) return `<p class="muted">No trades yet. Log your first one.</p>`
  if (!visible.length) return `<p class="muted">No trades match these filters.</p>`

  return `
    <div class="table-wrap">
      <table class="trades">
        <thead><tr>
          <th>Trade</th><th>Date</th><th>Dir</th><th>Status</th><th>Account</th><th>Setup</th>
          <th class="num">Risk</th><th class="num">P&amp;L</th>
        </tr></thead>
        <tbody>${renderRows(visible, accountsById)}</tbody>
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
 * change re-renders the table from the array already in memory. The account
 * list is fetched alongside it — it names the dropdown's options and colours
 * the table's Account column, and it is a handful of rows.
 */
export async function renderJournal(el, { header } = {}) {
  el.innerHTML = `<p class="muted">Loading trades…</p>`

  let trades
  let accounts
  try {
    ;[trades, accounts] = await Promise.all([listTrades(), listAccounts()])
  } catch (err) {
    el.innerHTML = `<p class="err">${esc(explainFailure(err, { prefix: 'Could not load trades' }))}</p>`
    return
  }

  const accountsById = new Map(accounts.map((a) => [a.id, a]))

  const reload = () => renderJournal(el, { header })

  // Saving a trade remounts this whole view, so the selected account has to
  // outlive the mount — otherwise editing a trade would drop the trader back to
  // all-accounts totals without them touching the dropdown.
  const filters = {
    ...NO_FILTERS,
    account: rememberedFilter(accounts.map((a) => a.id), [UNASSIGNED]),
  }

  // The tiles and the sidebar answer to the account alone, not to the search
  // box or the status filter — see `byAccount` in filters.js. `paint` publishes
  // it, so there is no separate summary call on mount.
  const summarise = () => computeStats(byAccount(trades, filters.account))

  // The shell owns the topbar; the view owns what goes in it. Clearing first
  // keeps a reload from stacking a second button.
  if (header) {
    header.innerHTML = `<button type="button" class="btn-add" data-act="new">+ Log trade</button>`
    header
      .querySelector('[data-act="new"]')
      .addEventListener('click', () => openTradeForm({ onSaved: reload }))
  }

  el.innerHTML = `
    <div id="trade-stats"></div>
    ${renderFilters(filters, accounts)}
    <div id="trade-table"></div>
  `

  const table = el.querySelector('#trade-table')
  const statsEl = el.querySelector('#trade-stats')

  const paint = () => {
    const visible = applyFilters(trades, filters)
    const stats = summarise()

    // Tiles, sidebar and table are painted together so they can never disagree
    // about which account is on screen. `trades.length` stays the total: an
    // account with nothing on it has no trades *matching the filters*, which is
    // not the same as having logged none at all.
    statsEl.innerHTML = renderStats(stats)
    publishSummary(stats)
    table.innerHTML = renderTable(visible, trades.length, accountsById)

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

  el.querySelector('#f-account').addEventListener('change', (e) => {
    filters.account = e.target.value
    rememberFilter(filters.account)
    paint()
  })

  // Creating, deleting or assigning changes the dropdown's options and the
  // table's Account column, so the modal reloads the view rather than trying to
  // patch it. It only calls back when something was actually written.
  el.querySelector('[data-act="accounts"]').addEventListener('click', () => {
    openAccountsModal({ onChanged: reload })
  })

  paint()
}
