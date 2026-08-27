import {
  ACCOUNT_TYPES, DEFAULT_ACCOUNT_TYPE, ACCOUNT_NAME_MAX, ACCOUNT_NOTE_MAX, validateAccount,
  BACKTEST_ACCOUNT_TYPE, backtestAccountIds,
} from '../domain/account-vocab.js'
import { isRealTrade, isVeto } from '../domain/veto-vocab.js'
import {
  listAccounts, createAccount, deleteAccount, countTradesByAccount, assignTradesToAccount,
} from './accounts.js'
import { listTrades } from './trades.js'
import { tradeLabel, SCOPES } from './filters.js'
import { accountTypeClass, accountTypeBadge, accountName } from '../lib/account-badges.js'
import { fmtMoney } from './stats.js'
import { esc, explainFailure } from '../lib/ui-text.js'

/**
 * The Accounts modal: list, create, inspect, assign, delete.
 *
 * One overlay with four modes rather than four modals. They are steps in the
 * same task — you open Accounts to look at an account, and deleting or
 * assigning is something you decide *while looking at it* — so stacking a
 * second overlay on top would bury the context the decision needs.
 *
 * Mirrors the trade form's shape (openTradeForm in form.js): a detail view you
 * reach by clicking a row, with the destructive action at the bottom left.
 */

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

const TITLES = {
  list: 'Accounts',
  create: 'New account',
  detail: 'Account',
  assign: 'Assign trades',
}

/** Plural that reads correctly at 1 without an "(s)". */
const tradeCount = (n) => `${n} ${n === 1 ? 'trade' : 'trades'}`

/**
 * An account's row count, with vetoes named separately rather than folded in.
 * "7 trades" beside a Net P&L that only nine of them contributed to is a panel
 * that contradicts itself — the same reason the counts here are taken from the
 * loaded window rather than queried exactly.
 */
const entryCount = (trades, vetoes) =>
  vetoes ? `${tradeCount(trades)} · ${vetoes} veto${vetoes === 1 ? '' : 'es'}` : tradeCount(trades)

const typePill = (type, selected) =>
  `<button type="button" class="pill acct-pill ${accountTypeClass(type)}${type === selected ? ' on' : ''}"
           data-type="${esc(type)}" aria-pressed="${type === selected}">${esc(type)}</button>`

function renderList(accounts, counts, vetoCounts, backtest) {
  if (!accounts.length) {
    return backtest
      ? `<p class="muted">No backtest accounts yet. Create one — it behaves exactly like a real
         account, but its entries stay out of the live journal and out of every live statistic.</p>`
      : `<p class="muted">No accounts yet. Create one, then pick it when you log a trade.</p>`
  }

  // Unassigned trades belong to the live journal (see byScope in filters.js), so
  // the hint that offers to file them would be pointing at the wrong journal
  // here. Backtest entries always have an account; the form refuses otherwise.
  const unassigned = backtest ? 0 : (counts.get(null) ?? 0)

  return `
    <div class="acct-list">
      ${accounts
        .map(
          (a) => `
        <button type="button" class="acct-row" data-account="${esc(a.id)}">
          <span class="acct-row-main">
            ${accountName(a)}
            ${accountTypeBadge(a.type)}
          </span>
          <span class="acct-row-meta">${entryCount(counts.get(a.id) ?? 0, vetoCounts.get(a.id) ?? 0)}</span>
        </button>`
        )
        .join('')}
    </div>
    ${
      unassigned
        ? `<p class="muted acct-hint">${tradeCount(unassigned)} not on any account —
           open an account and choose <b>Assign trades</b> to move them onto it.</p>`
        : ''
    }`
}

const renderCreate = (draft) => `
  <div class="acct-form">
    <div class="field">
      <span class="form-label">Account type</span>
      <div class="pill-row">${ACCOUNT_TYPES.map((t) => typePill(t, draft.type)).join('')}</div>
    </div>
    <label>Name
      <input type="text" id="a-name" maxlength="${ACCOUNT_NAME_MAX}" placeholder="e.g. Eval1"
             value="${esc(draft.name)}" autocomplete="off">
    </label>
    <label>Note <span class="opt">optional</span>
      <textarea id="a-note" maxlength="${ACCOUNT_NOTE_MAX}"
                placeholder="Rules, size, drawdown limit — whatever you want to see here later">${esc(draft.note)}</textarea>
    </label>
  </div>`

const renderDetail = (account, count, stats) => `
  <div class="acct-detail">
    <div class="acct-detail-head">
      <h3 class="acct-detail-name ${accountTypeClass(account.type)}">${esc(account.name)}</h3>
      ${accountTypeBadge(account.type)}
    </div>

    <div class="acct-facts">
      <div class="acct-fact"><span class="stat-label">Trades</span><b>${count}</b></div>
      <div class="acct-fact">
        <span class="stat-label">Net P&amp;L</span>
        <b class="${stats.netPnl >= 0 ? 'ok' : 'bad'}">${fmtMoney(stats.netPnl)}</b>
      </div>
      <div class="acct-fact"><span class="stat-label">Win rate</span><b>${stats.winRate}%</b></div>
    </div>

    ${account.note ? `<p class="acct-note">${esc(account.note)}</p>` : '<p class="muted">No note.</p>'}
  </div>`

/**
 * The assign picker. Trades already on an account are listed but not
 * selectable — reassigning is not what this flow is for, and showing them
 * greyed out answers "where did #47 go?" without a second screen.
 */
function renderAssign(account, trades, picked) {
  const free = trades.filter((t) => !t.account_id)
  if (!trades.length) return `<p class="muted">No trades to assign.</p>`

  return `
    <p class="muted acct-hint">
      Tick the trades taken on ${accountName(account)}.
      ${free.length ? '' : 'Every trade is already on an account.'}
    </p>
    <div class="acct-picker">
      ${trades
        .map((t) => {
          const taken = !!t.account_id
          const pnl = Number(t.pnl ?? 0)
          return `
            <label class="acct-pick${taken ? ' taken' : ''}">
              <input type="checkbox" data-trade="${esc(t.id)}" ${taken ? 'disabled' : ''}
                     ${picked.has(t.id) ? 'checked' : ''}>
              <span class="acct-pick-label">${esc(tradeLabel(t))}</span>
              <span class="acct-pick-date">${esc(t.date ?? '')}</span>
              <span class="acct-pick-pnl ${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtMoney(pnl)}</span>
              <span class="acct-pick-on">${taken ? esc(t.accountLabel ?? 'assigned') : ''}</span>
            </label>`
        })
        .join('')}
    </div>`
}

/**
 * Opens the modal. `onChanged` fires after any write that the journal behind it
 * would render differently — a created or deleted account, or an assignment.
 * It is not called on close, so cancelling costs nothing.
 */
export async function openAccountsModal({ onChanged, scope = SCOPES.LIVE } = {}) {
  // Opened from the Backtest journal, this manages backtest accounts only, and
  // creating one defaults to the Backtest type. Showing all five types in one
  // list would make "which accounts does this journal have" a question you
  // answer by reading badges.
  const backtest = scope === SCOPES.BACKTEST

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.innerHTML = `
    <div class="modal modal-sm">
      <header class="modal-head">
        <h2 id="a-title">Accounts</h2>
        <button type="button" class="ghost icon" data-act="close" aria-label="Close">${CLOSE_ICON}</button>
      </header>
      <div class="modal-body" id="a-body"><p class="muted">Loading accounts…</p></div>
      <p class="err" id="a-err"></p>
      <footer class="modal-foot" id="a-foot"></footer>
    </div>`
  document.body.append(overlay)

  const $ = (sel) => overlay.querySelector(sel)
  const body = $('#a-body')
  const foot = $('#a-foot')
  const err = $('#a-err')

  /** True once anything has been written, so close() knows whether to reload. */
  let dirty = false

  let accounts = []
  let counts = new Map()
  let vetoCounts = new Map()
  let trades = []
  let mode = 'list'
  let current = null
  let draft = {
    name: '',
    note: '',
    type: backtest ? BACKTEST_ACCOUNT_TYPE : DEFAULT_ACCOUNT_TYPE,
  }
  let picked = new Set()

  function close() {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    if (dirty) onChanged?.()
  }

  function onKey(e) {
    if (e.key === 'Escape') close()
  }

  /**
   * Trades on one account, for the detail view's tiles. Vetoes are dropped
   * first: they have no fill, so counting them would put a zero into the
   * win-rate denominator for a trade that was never taken.
   */
  const statsFor = (accountId) => {
    const own = trades.filter((t) => t.account_id === accountId && isRealTrade(t))
    const wins = own.filter((t) => Number(t.pnl ?? 0) > 0).length
    return {
      netPnl: own.reduce((a, t) => a + Number(t.pnl ?? 0), 0),
      winRate: own.length ? Math.round((wins / own.length) * 100) : 0,
    }
  }

  const button = (act, label, cls = 'ghost') =>
    `<button type="button" class="${cls}" data-act="${esc(act)}">${label}</button>`

  function renderFoot() {
    if (mode === 'list') {
      foot.innerHTML = `<span class="spacer"></span>${button('new', '+ New account', '')}`
    } else if (mode === 'create') {
      foot.innerHTML = `${button('back', 'Cancel')}<span class="spacer"></span>${button('create', 'Create account', '')}`
    } else if (mode === 'detail') {
      foot.innerHTML =
        `${button('delete', 'Delete', 'ghost danger')}<span class="spacer"></span>` +
        `${button('back', 'Back')}${button('assign-start', 'Assign trades', '')}`
    } else {
      const n = picked.size
      foot.innerHTML =
        `${button('back-detail', 'Back')}<span class="spacer"></span>` +
        `<button type="button" data-act="assign-save"${n ? '' : ' disabled'}>` +
        `${n ? `Assign ${tradeCount(n)}` : 'Assign trades'}</button>`
    }
  }

  function render() {
    $('#a-title').textContent = TITLES[mode]
    err.textContent = ''

    if (mode === 'list') body.innerHTML = renderList(accounts, counts, vetoCounts, backtest)
    else if (mode === 'create') body.innerHTML = renderCreate(draft)
    else if (mode === 'detail') {
      body.innerHTML = renderDetail(current, counts.get(current.id) ?? 0, statsFor(current.id))
    } else body.innerHTML = renderAssign(current, trades, picked)

    renderFoot()
    if (mode === 'create') $('#a-name').focus()
  }

  /** Re-reads accounts and trades; every count and total below derives from these. */
  async function load() {
    const [all, loaded] = await Promise.all([listAccounts(), listTrades()])

    // The picker shows which account a taken trade is already on, and the
    // trades it lists carry only an id. Labels come from *every* account, not
    // just this journal's — a trade already filed elsewhere should say so.
    const byId = new Map(all.map((a) => [a.id, a.name]))
    trades = loaded.map((t) => ({ ...t, accountLabel: byId.get(t.account_id) ?? null }))

    // Counted separately so the row can say "9 trades · 3 vetoes" and the
    // account's Net P&L stays a total of the nine.
    counts = countTradesByAccount(trades.filter(isRealTrade))
    vetoCounts = countTradesByAccount(trades.filter(isVeto))

    const backtestIds = backtestAccountIds(all)
    accounts = all.filter((a) => backtestIds.has(a.id) === backtest)
  }

  const fail = (e, prefix) => {
    err.textContent = explainFailure(e, { prefix })
  }

  async function submitCreate(btn) {
    draft = {
      ...draft,
      name: $('#a-name').value,
      note: $('#a-note').value,
    }

    const problem = validateAccount(draft, accounts.map((a) => a.name))
    if (problem) return void (err.textContent = problem)

    btn.disabled = true
    try {
      const created = await createAccount(draft)
      dirty = true
      await load()
      draft = { name: '', note: '', type: DEFAULT_ACCOUNT_TYPE }
      // Straight into the new account: creating one is nearly always followed
      // by assigning trades to it or checking it reads right.
      current = accounts.find((a) => a.id === created.id) ?? null
      mode = current ? 'detail' : 'list'
      render()

      // Every type is offered from either journal, so you can create a Backtest
      // account without first navigating to the Backtest journal. When you do,
      // it lands in the other journal's list and silently vanishing from this
      // one would read as a failed save.
      if (!current) {
        const where = created.type === BACKTEST_ACCOUNT_TYPE ? 'Backtest journal' : 'live journal'
        err.textContent = `Created “${created.name}” as a ${created.type} account — it lives in the ${where}.`
      }
    } catch (e) {
      fail(e, 'Could not create the account')
      btn.disabled = false
    }
  }

  async function confirmDelete() {
    // Every row on the account, vetoes included — they survive the delete too,
    // and a warning that undercounts what it is about to orphan is worse than
    // no warning.
    const n = (counts.get(current.id) ?? 0) + (vetoCounts.get(current.id) ?? 0)
    const warning = n
      ? `Delete “${current.name}”?\n\nIts ${tradeCount(n)} will be kept, but will no longer be on any account.`
      : `Delete “${current.name}”?`
    if (!confirm(warning)) return

    try {
      await deleteAccount(current.id)
      dirty = true
      await load()
      current = null
      mode = 'list'
      render()
    } catch (e) {
      fail(e, 'Could not delete the account')
    }
  }

  async function saveAssignment(btn) {
    btn.disabled = true
    const wanted = picked.size
    try {
      const moved = await assignTradesToAccount([...picked], current.id)
      dirty = true
      picked = new Set()
      const id = current.id
      await load()
      current = accounts.find((a) => a.id === id) ?? null
      mode = current ? 'detail' : 'list'
      render()

      // `moved` falls short of what was ticked only if a trade gained an
      // account elsewhere since the list was drawn — the guard in
      // assignTradesToAccount skips it rather than stealing it. Silence here
      // would leave the trader thinking all of them moved.
      if (moved < wanted) {
        err.textContent = `Assigned ${tradeCount(moved)} of ${wanted} — the rest were already on another account.`
      }
    } catch (e) {
      fail(e, 'Could not assign the trades')
      btn.disabled = false
    }
  }

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) return close()

    const type = e.target.closest('.acct-pill')?.dataset.type
    if (type) {
      draft = { ...draft, name: $('#a-name').value, note: $('#a-note').value, type }
      return render()
    }

    const row = e.target.closest('.acct-row')
    if (row) {
      current = accounts.find((a) => a.id === row.dataset.account)
      if (!current) return
      mode = 'detail'
      return render()
    }

    const act = e.target.closest('[data-act]')?.dataset.act
    const btn = e.target.closest('[data-act]')
    if (!act) return

    if (act === 'close') close()
    else if (act === 'new') {
      mode = 'create'
      render()
    } else if (act === 'back') {
      mode = 'list'
      current = null
      render()
    } else if (act === 'back-detail') {
      mode = 'detail'
      picked = new Set()
      render()
    } else if (act === 'create') await submitCreate(btn)
    else if (act === 'delete') await confirmDelete()
    else if (act === 'assign-start') {
      mode = 'assign'
      picked = new Set()
      render()
    } else if (act === 'assign-save') await saveAssignment(btn)
  })

  // Ticking a box only updates the count on the button; re-rendering the whole
  // picker here would scroll a long list back to the top on every click.
  overlay.addEventListener('change', (e) => {
    const id = e.target.dataset?.trade
    if (!id) return
    e.target.checked ? picked.add(id) : picked.delete(id)
    renderFoot()
  })

  document.addEventListener('keydown', onKey)

  try {
    await load()
    render()
  } catch (e) {
    body.innerHTML = `<p class="err">${esc(explainFailure(e, { prefix: 'Could not load accounts' }))}</p>`
  }
}
