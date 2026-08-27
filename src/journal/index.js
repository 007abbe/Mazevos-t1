import { listTrades } from './trades.js'
import { listAccounts, rememberedFilter, rememberFilter } from './accounts.js'
import { openAccountsModal } from './accounts-ui.js'
import { computeStats, fmtMoney, fmtNum } from './stats.js'
import { openTradeForm } from './form.js'
import {
  applyFilters, byAccount, byScope, tradeLabel, SORTS, STATUSES, DIRECTIONS, NO_FILTERS,
  UNASSIGNED, SCOPES,
} from './filters.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { isVeto, VETO_OUTCOME_LABELS } from '../domain/veto-vocab.js'
import { discretionDelta } from '../domain/discretion.js'
import { publishSummary } from '../lib/summary.js'
import { directionBadge, statusBadge } from '../lib/trade-badges.js'
import { accountName } from '../lib/account-badges.js'
import { esc, explainFailure } from '../lib/ui-text.js'

const statTile = (label, value, cls = '', title = '') =>
  `<div class="stat"${title ? ` title="${esc(title)}"` : ''}>
     <span class="stat-label">${label}</span><b class="${cls}">${value}</b>
   </div>`

/**
 * The number this whole discretion audit exists to produce: mean actual R minus
 * mean mechanical R, over the entries where a strict mechanical run would have
 * fired. Positive means your judgement earned its keep.
 *
 * The sample size rides in the label rather than a tooltip, because a +0.8R
 * delta over three entries and one over forty are different claims and the tile
 * has to say which it is. With nothing to compare it stays an em dash — a 0.00
 * would read as "your discretion is exactly neutral", which is a finding, not
 * an absence of one.
 */
function discretionTile(rows) {
  const { delta, n, tagged, avgActualR, avgMechR } = discretionDelta(rows)

  if (delta === null) {
    const hint = tagged
      ? `${tagged} entr${tagged === 1 ? 'y' : 'ies'} answered “mech trigger: yes”, but none recorded a counterfactual R to compare against.`
      : 'Answer “mech trigger: yes” and record a counterfactual R on an entry to start measuring this.'
    return statTile('Discretion Δ', '—', 'muted-stat', hint)
  }

  const sign = delta > 0 ? '+' : ''
  return statTile(
    `Discretion Δ <span class="stat-n">n=${n}</span>`,
    `${sign}${delta.toFixed(2)}R`,
    delta > 0 ? 'ok' : delta < 0 ? 'bad' : '',
    `You averaged ${avgActualR.toFixed(2)}R where a mechanical run would have averaged ${avgMechR.toFixed(2)}R, over ${n} entr${n === 1 ? 'y' : 'ies'}.`
  )
}

function renderStats(stats, rows) {
  return `
    <div class="stats">
      ${statTile('Trades', stats.count)}
      ${statTile('Win rate', `${stats.winRate}%`)}
      ${statTile('Net P&amp;L', fmtMoney(stats.netPnl), stats.netPnl >= 0 ? 'ok' : 'bad')}
      ${statTile('Profit factor', fmtNum(stats.profitFactor))}
      ${statTile('Avg win', fmtMoney(stats.avgWin), 'ok')}
      ${statTile('Avg loss', fmtMoney(-stats.avgLoss), 'bad')}
      ${statTile('Avg R', fmtNum(stats.avgR))}
      ${discretionTile(rows)}
      ${
        // Only once there is one. An always-on "Vetoes 0" tile would take a slot
        // from a number that is doing work.
        stats.vetoes
          ? statTile('Vetoes', stats.vetoes, 'veto-stat', 'Ideas you passed on. Excluded from every tile to the left.')
          : ''
      }
    </div>
  `
}

const option = (value, label, selected) =>
  `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`

/**
 * "Both" first, and it is the default. A veto you cannot see by default is a
 * veto you stop bothering to log.
 */
const KIND_OPTIONS = [
  { value: '', label: 'Trades & vetoes' },
  { value: 'trade', label: 'Trades only' },
  { value: 'veto', label: 'Vetoes only' },
]

function renderFilters(filters, accounts, scope) {
  const backtest = scope === SCOPES.BACKTEST
  return `
    <div class="filters">
      <input class="search-box" type="search" id="f-search" placeholder="Search ticker, thesis…"
             value="${esc(filters.search)}" aria-label="Search trades">
      <select class="filter-select" id="f-kind" aria-label="Filter by entry kind">
        ${KIND_OPTIONS.map((k) => option(k.value, k.label, filters.kind)).join('')}
      </select>
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
        ${option('', backtest ? 'All backtest accounts' : 'All accounts', filters.account)}
        ${accounts.map((a) => option(a.id, a.name, filters.account)).join('')}
        ${backtest ? '' : option(UNASSIGNED, 'Unassigned', filters.account)}
      </select>
      <button type="button" class="ghost btn-accounts" data-act="accounts">Accounts</button>
      <button type="button" class="ghost btn-accounts btn-scope" data-act="switch-scope">
        ${backtest ? 'Journal' : 'Backtest'}
      </button>
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

const OUTCOME_CLASSES = {
  win: 'badge-tp',
  loss: 'badge-sl',
  breakeven: 'badge-be',
  unclear: 'badge-be',
}

/**
 * A veto's outcome, in the Status column's slot. It borrows the status colours
 * so a would-be winner still reads green, but the wording ("Would win") keeps
 * it from being mistaken for a filled TP at a glance.
 */
const outcomeBadge = (outcome) =>
  outcome
    ? `<span class="badge ${OUTCOME_CLASSES[outcome] ?? 'badge-be'}">${esc(VETO_OUTCOME_LABELS[outcome])}</span>`
    : '<span class="acct-none">—</span>'

function renderRows(trades, accountsById) {
  return trades
    .slice(0, 50)
    .map((t) => {
      const veto = isVeto(t)
      const pnl = Number(t.pnl ?? 0)

      // Risk and P&L are blanked rather than shown as $0: a veto was never
      // filled, and a column of zeroes reads as a run of scratched trades.
      return `
        <tr data-id="${esc(t.id)}" tabindex="0" class="${veto ? 'row-veto' : ''}">
          <td class="mono">${esc(tradeLabel(t))}${veto ? '<span class="badge badge-veto">Veto</span>' : ''}</td>
          <td class="mono">${esc(t.date ?? '')}</td>
          <td>${directionBadge(t.type)}</td>
          <td>${veto ? outcomeBadge(t.veto_outcome) : statusBadge(t.status)}</td>
          <td class="acct-cell">${accountName(accountsById.get(t.account_id))}</td>
          <td>${esc(tradeSetup(t))}</td>
          <td class="num risk-cell">${veto ? '—' : fmtRisk(t.risk)}</td>
          <td class="num ${veto ? '' : pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${veto ? '—' : fmtMoney(pnl)}</td>
        </tr>
      `
    })
    .join('')
}

/** What an empty table should say, which depends on why it is empty. */
function emptyMessage(scope, hasAccounts) {
  if (scope !== SCOPES.BACKTEST) return 'No trades yet. Log your first one.'
  return hasAccounts
    ? 'No backtest entries yet. Log your first one.'
    : 'No backtest accounts yet. Open Accounts → New account and pick the Backtest type, then log against it.'
}

function renderTable(visible, total, accountsById, scope, hasAccounts) {
  if (!total) return `<p class="muted">${esc(emptyMessage(scope, hasAccounts))}</p>`
  if (!visible.length) return `<p class="muted">No entries match these filters.</p>`

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
 * list is fetched alongside it — it names the dropdown's options, colours the
 * table's Account column, and decides which of the two journals each trade
 * belongs to.
 *
 * `scope` picks that journal. Both are this same view over a different slice:
 * the live one, and the one over Backtest accounts. Sharing the implementation
 * is the point — a backtest is only worth keeping if it is journalled to the
 * same standard as a real trade, which means the same tags, the same filters
 * and the same discretion audit.
 */
export async function renderJournal(el, { header, navigate, scope = SCOPES.LIVE } = {}) {
  el.innerHTML = `<p class="muted">Loading trades…</p>`

  let allTrades
  let allAccounts
  try {
    ;[allTrades, allAccounts] = await Promise.all([listTrades(), listAccounts()])
  } catch (err) {
    el.innerHTML = `<p class="err">${esc(explainFailure(err, { prefix: 'Could not load trades' }))}</p>`
    return
  }

  // The partition happens once, here, and everything below works on `trades`.
  // Doing it at the top rather than inside each filter is what makes it
  // impossible for a tile, the sidebar or the table to disagree about which
  // journal is on screen.
  const backtestIds = backtestAccountIds(allAccounts)
  const wantBacktest = scope === SCOPES.BACKTEST
  const trades = byScope(allTrades, scope, backtestIds)
  const accounts = allAccounts.filter((a) => backtestIds.has(a.id) === wantBacktest)

  const accountsById = new Map(allAccounts.map((a) => [a.id, a]))

  const reload = () => renderJournal(el, { header, navigate, scope })

  // Saving a trade remounts this whole view, so the selected account has to
  // outlive the mount — otherwise editing a trade would drop the trader back to
  // all-accounts totals without them touching the dropdown. Remembered per
  // scope: the two journals do not share a selection.
  const filters = {
    ...NO_FILTERS,
    account: rememberedFilter(accounts.map((a) => a.id), wantBacktest ? [] : [UNASSIGNED], scope),
  }

  // The tiles and the sidebar answer to the account alone, not to the search
  // box or the status filter — see `byAccount` in filters.js. Vetoes stay in
  // this set: `computeStats` drops them from every P&L number itself, and the
  // discretion delta needs them.
  const summarise = () => byAccount(trades, filters.account)

  // The shell owns the topbar; the view owns what goes in it. Clearing first
  // keeps a reload from stacking a second button.
  if (header) {
    header.innerHTML = `<button type="button" class="btn-add" data-act="new">+ Log ${wantBacktest ? 'entry' : 'trade'}</button>`
    header
      .querySelector('[data-act="new"]')
      .addEventListener('click', () => openTradeForm({ scope, onSaved: reload }))
  }

  el.innerHTML = `
    <div id="trade-stats"></div>
    ${renderFilters(filters, accounts, scope)}
    <div id="trade-table"></div>
  `

  const table = el.querySelector('#trade-table')
  const statsEl = el.querySelector('#trade-stats')

  const paint = () => {
    const visible = applyFilters(trades, filters)
    const rows = summarise()
    const stats = computeStats(rows)

    // Tiles, sidebar and table are painted together so they can never disagree
    // about which account is on screen. `trades.length` stays this journal's
    // total: an account with nothing on it has no trades *matching the filters*,
    // which is not the same as having logged none at all.
    statsEl.innerHTML = renderStats(stats, rows)
    publishSummary(stats)
    table.innerHTML = renderTable(visible, trades.length, accountsById, scope, accounts.length)

    const openRow = (row) =>
      openTradeForm({ trade: trades.find((t) => t.id === row.dataset.id), scope, onSaved: reload })

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
  bind('#f-kind', 'kind', 'change')
  bind('#f-status', 'status', 'change')
  bind('#f-direction', 'direction', 'change')
  bind('#f-sort', 'sort', 'change')

  el.querySelector('#f-account').addEventListener('change', (e) => {
    filters.account = e.target.value
    rememberFilter(filters.account, scope)
    paint()
  })

  // Creating, deleting or assigning changes the dropdown's options and the
  // table's Account column, so the modal reloads the view rather than trying to
  // patch it. It only calls back when something was actually written.
  el.querySelector('[data-act="accounts"]').addEventListener('click', () => {
    openAccountsModal({ scope, onChanged: reload })
  })

  el.querySelector('[data-act="switch-scope"]').addEventListener('click', () => {
    navigate?.(wantBacktest ? 'journal' : 'backtest')
  })

  paint()
}
