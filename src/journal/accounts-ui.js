import {
  ACCOUNT_TYPES, DEFAULT_ACCOUNT_TYPE, ACCOUNT_NAME_MAX, ACCOUNT_NOTE_MAX, validateAccount,
  BACKTEST_ACCOUNT_TYPE, backtestAccountIds,
} from '../domain/account-vocab.js'
import {
  accountProgress, accountBadgeState, BADGE_LABELS, hasGoals, normaliseGoals, validateGoals,
  PROP_PRESETS, DRAWDOWN_TYPES, ACCOUNT_STATUSES, STATUS_LABELS,
} from '../domain/account-goals.js'
import { tickTally, fmtTicks, isoDay } from '../domain/ticks.js'
import { isRealTrade, isVeto } from '../domain/veto-vocab.js'
import {
  listAccounts, createAccount, deleteAccount, countTradesByAccount, assignTradesToAccount,
  updateAccountGoals, goalsAvailable,
} from './accounts.js'
import { listTrades } from './trades.js'
import { tradeLabel, SCOPES } from './filters.js'
import { accountTypeClass, accountTypeBadge, accountName } from '../lib/account-badges.js'
import { fmtMoney, fmtNum, computeStats } from './stats.js'
import { esc, explainFailure } from '../lib/ui-text.js'

/**
 * The Accounts modal: list, create, inspect, set goals, assign, delete.
 *
 * One overlay with five modes rather than five modals. They are steps in the
 * same task — you open Accounts to look at an account, and deleting, assigning
 * or changing its rules is something you decide *while looking at it* — so
 * stacking a second overlay on top would bury the context the decision needs.
 *
 * Mirrors the trade form's shape (openTradeForm in form.js): a detail view you
 * reach by clicking a row, with the destructive action at the bottom left.
 *
 * Every number on the detail view is derived from the trades on the account —
 * see accountProgress in src/domain/account-goals.js. The account row stores
 * only the rules.
 */

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

const TITLES = {
  list: 'Accounts',
  create: 'New account',
  detail: 'Account',
  goals: 'Goals & rules',
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

/** Signed whole dollars — a gain or a loss. */
const usd = (n) => (n === null || n === undefined ? '—' : fmtMoney(n))

/** Unsigned whole dollars, for balances and limits that are never "a gain". */
const plain = (n) => (n === null || n === undefined ? '—' : `$${Math.round(n).toLocaleString('en-US')}`)

const BADGE_CLASSES = {
  active: 'badge-open',
  'target-hit': 'badge-tp',
  passed: 'badge-tp',
  breached: 'badge-sl',
  failed: 'badge-sl',
  retired: 'badge-be',
}

const stateBadge = (state) =>
  `<span class="badge ${BADGE_CLASSES[state] ?? 'badge-be'}">${esc(BADGE_LABELS[state] ?? state)}</span>`

/** A thin meter, 0..1. */
const meter = (value, tone) =>
  `<span class="meter"><span class="meter-fill ${tone}" style="width:${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%"></span></span>`

/** Green until half the allowance is gone, amber to three quarters, then red. */
const usageTone = (used) => (used >= 0.75 ? 'bad' : used >= 0.5 ? 'warn' : 'ok')

/** Whether an account has anything a status badge would say. */
const showsState = (account) => hasGoals(account) || !!account.status

function renderList(accounts, counts, vetoCounts, backtest, progressFor) {
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

  const row = (a) => {
    const p = progressFor(a)
    // Dimmed, not reordered: the list keeps creation order so nothing reshuffles.
    const dim = a.status === 'retired' || a.status === 'failed'
    const meters = [
      p.targetProgress !== null &&
        `<span class="acct-row-meter"><span>Target ${Math.round(p.targetProgress * 100)}%</span>${meter(p.targetProgress, 'ok')}</span>`,
      p.drawdownUsed !== null &&
        `<span class="acct-row-meter"><span>Buffer ${plain(p.buffer)}</span>${meter(p.drawdownUsed, usageTone(p.drawdownUsed))}</span>`,
    ].filter(Boolean)

    return `
      <button type="button" class="acct-row acct-card${dim ? ' dim' : ''}" data-account="${esc(a.id)}">
        <span class="acct-row-top">
          <span class="acct-row-main">
            ${accountName(a)}
            ${accountTypeBadge(a.type)}
            ${showsState(a) ? stateBadge(accountBadgeState(a, p)) : ''}
          </span>
          <span class="acct-row-pnl ${p.net >= 0 ? 'pnl-pos' : 'pnl-neg'}">${usd(p.net)}</span>
        </span>
        <span class="acct-row-meta">${[
          a.firm ? esc(a.firm) : '',
          p.balance === null ? '' : plain(p.balance),
          entryCount(counts.get(a.id) ?? 0, vetoCounts.get(a.id) ?? 0),
        ]
          .filter(Boolean)
          .join(' · ')}</span>
        ${meters.length ? `<span class="acct-row-meters">${meters.join('')}</span>` : ''}
      </button>`
  }

  return `
    <div class="acct-list">${accounts.map(row).join('')}</div>
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

/**
 * Balance over trading days, with the drawdown floor dashed beneath it and the
 * starting balance as a faint rule. Inline SVG — a chart library for one line
 * would outweigh the panel.
 */
function equityChart(curve, size) {
  if (curve.length < 2) return ''
  const W = 600
  const H = 120
  const hasFloor = curve[0].floor !== null
  const values = curve.flatMap((p) => (hasFloor ? [p.balance, p.floor] : [p.balance])).concat(size)
  const lo = Math.min(...values)
  const span = Math.max(...values) - lo || 1
  const x = (i) => ((i / (curve.length - 1)) * W).toFixed(1)
  const y = (v) => (H - 6 - ((v - lo) / span) * (H - 12)).toFixed(1)
  const line = (key) => curve.map((p, i) => `${x(i)},${y(p[key])}`).join(' ')
  const last = curve[curve.length - 1]

  return `
    <div class="acct-chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="Balance ${plain(last.balance)} over ${curve.length} trading days">
        <line class="eq-start" x1="0" x2="${W}" y1="${y(size)}" y2="${y(size)}"/>
        ${hasFloor ? `<polyline class="eq-floor" points="${line('floor')}"/>` : ''}
        <polyline class="eq-line ${last.balance >= size ? 'up' : 'down'}" points="${line('balance')}"/>
      </svg>
      <div class="acct-chart-legend">
        <span><i class="lg-line"></i>Balance</span>
        ${hasFloor ? '<span><i class="lg-floor"></i>Drawdown floor</span>' : ''}
        <span><i class="lg-start"></i>Start</span>
      </div>
    </div>`
}

/** One rule: a pass/fail dot, a meter, and the numbers behind it. */
const ruleRow = (label, value, tone, detail, ok) => `
  <div class="rule-row">
    <span class="rule-label"><i class="rule-dot ${ok ? 'ok' : 'bad'}"></i>${label}</span>
    ${value === null ? '<span></span>' : meter(value, tone)}
    <span class="rule-detail">${detail}</span>
  </div>`

const warn = (text) => `<span class="rule-warn">${text}</span>`

function renderRules(account, p) {
  const rows = []

  if (p.requiredTarget !== null) {
    const raised = p.requiredTarget > p.target
    rows.push(
      ruleRow(
        'Profit target',
        p.targetProgress,
        'ok',
        `${usd(p.net)} of ${plain(p.requiredTarget)}${raised ? ` · ${warn(`raised from ${plain(p.target)} by consistency`)}` : ''} · ${
          p.toTarget ? `${plain(p.toTarget)} to go` : 'reached'
        }`,
        p.toTarget === 0
      )
    )
  }

  if (p.floor !== null) {
    const kind = DRAWDOWN_TYPES.find((d) => d.value === (account.drawdown_type || 'eod'))?.label ?? ''
    rows.push(
      ruleRow(
        'Max drawdown',
        p.drawdownUsed,
        usageTone(p.drawdownUsed ?? 0),
        `${plain(p.buffer)} above floor ${plain(p.floor)} · ${esc(kind)}${p.floorLocked ? ' · locked' : ''}${
          p.breachedOn ? ` · ${warn(`breached ${esc(p.breachedOn)}`)}` : ''
        }`,
        !p.breachedOn
      )
    )
  }

  if (p.dailyLossLimit) {
    const worst = p.worstDay !== null && p.worstDay < 0 ? -p.worstDay : 0
    const hits = p.dllHits.length
    rows.push(
      ruleRow(
        'Daily loss limit',
        worst / p.dailyLossLimit,
        usageTone(worst / p.dailyLossLimit),
        `worst day ${usd(p.worstDay)} of ${plain(p.dailyLossLimit)}${hits ? ` · ${warn(`hit on ${hits} day${hits === 1 ? '' : 's'}`)}` : ''}`,
        !hits
      )
    )
  }

  if (p.consistencyPct) {
    rows.push(
      ruleRow(
        'Consistency',
        p.consistency === null ? null : p.consistency / 100,
        p.consistent ? 'ok' : 'warn',
        p.consistency === null
          ? `best day ≤ ${p.consistencyPct}% of profit · no profit yet`
          : `best day ${usd(p.bestDay)} is ${Math.round(p.consistency)}% of profit · limit ${p.consistencyPct}%`,
        p.consistent
      )
    )
  }

  if (p.minDays) {
    rows.push(ruleRow('Trading days', p.tradingDays / p.minDays, 'ok', `${p.tradingDays} of ${p.minDays}`, p.daysMet))
  }

  if (p.monthlyGoal) {
    const month = p.monthPnl ?? 0
    rows.push(
      ruleRow('Monthly goal', month / p.monthlyGoal, 'ok', `${usd(month)} of ${plain(p.monthlyGoal)} this month`, month >= p.monthlyGoal)
    )
  }

  if (!rows.length) return ''
  return `
    <section class="acct-section">
      <h4 class="acct-section-title">Goals &amp; rules</h4>
      ${rows.join('')}
      ${
        p.floor !== null
          ? `<p class="muted acct-hint">Measured on closed trades by trading day. Your firm also counts
             open P&amp;L, so a live account can breach before this panel says so.</p>`
          : ''
      }
    </section>`
}

function renderDetail(account, count, own, p) {
  const stats = computeStats(own)
  const ticks = tickTally(own)
  const tone = (n) => (n === null || n === undefined ? '' : n > 0 ? 'ok' : n < 0 ? 'bad' : '')
  const fact = (label, value, cls = '') =>
    `<div class="acct-fact"><span class="stat-label">${label}</span><b class="${cls}">${value}</b></div>`

  return `
  <div class="acct-detail">
    <div class="acct-detail-head">
      <h3 class="acct-detail-name ${accountTypeClass(account.type)}">${esc(account.name)}</h3>
      ${accountTypeBadge(account.type)}
      ${showsState(account) ? stateBadge(accountBadgeState(account, p)) : ''}
      ${account.firm ? `<span class="acct-firm">${esc(account.firm)}</span>` : ''}
    </div>

    <div class="acct-facts">
      ${p.balance === null ? '' : fact('Balance', plain(p.balance))}
      ${fact('Net P&amp;L', usd(p.net), tone(p.net))}
      ${fact('Trades', count)}
      ${fact('Win rate', `${stats.winRate}%`)}
      ${fact('Profit factor', fmtNum(stats.profitFactor))}
      ${fact('Avg R', fmtNum(stats.avgR))}
      ${fact('Ticks', ticks.n ? fmtTicks(ticks.net) : '—', ticks.n ? tone(ticks.net) : '')}
      ${fact('Trading days', p.tradingDays)}
      ${fact('Best day', usd(p.bestDay), tone(p.bestDay))}
      ${fact('Worst day', usd(p.worstDay), tone(p.worstDay))}
    </div>

    ${p.size === null ? '' : equityChart(p.curve, p.size)}
    ${renderRules(account, p)}

    ${
      hasGoals(account)
        ? ''
        : goalsAvailable
          ? `<p class="muted acct-hint">No goals set. <b>Edit goals</b> to add a profit target, drawdown
             and prop-firm rules — a Lucid or Topstep preset fills them in.</p>`
          : `<p class="muted acct-hint">Goals need the <b>account_goals</b> migration run in Supabase.</p>`
    }

    ${account.note ? `<p class="acct-note">${esc(account.note)}</p>` : ''}
  </div>`
}

const goalField = (key, label, value, hint = '', step = 'any') => `
  <label>${label}${hint ? ` <span class="opt">${hint}</span>` : ''}
    <input type="number" min="0" step="${step}" data-goal="${key}" value="${value ?? ''}" inputmode="decimal">
  </label>`

/** The goals form. Values are read back from the inputs by `readGoals`, keyed by column. */
const renderGoals = (draft) => `
  <div class="acct-form">
    <label>Preset <span class="opt">fills the rules below — check them against your dashboard</span>
      <select id="g-preset">
        <option value="">Choose a preset…</option>
        ${PROP_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}
      </select>
    </label>
    <div class="grid goals-grid">
      <label>Firm <span class="opt">optional</span>
        <input type="text" data-goal="firm" maxlength="40" value="${esc(draft.firm ?? '')}" placeholder="e.g. Lucid">
      </label>
      <label>Status
        <select data-goal="status">
          ${ACCOUNT_STATUSES.map(
            (s) => `<option value="${s}"${(draft.status || 'active') === s ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`
          ).join('')}
        </select>
      </label>
      ${goalField('account_size', 'Starting balance', draft.account_size, '$')}
      ${goalField('profit_target', 'Profit target', draft.profit_target, '$')}
      ${goalField('max_drawdown', 'Max drawdown', draft.max_drawdown, '$')}
      <label>Drawdown type
        <select data-goal="drawdown_type">
          <option value="">—</option>
          ${DRAWDOWN_TYPES.map(
            (d) => `<option value="${d.value}"${draft.drawdown_type === d.value ? ' selected' : ''}>${d.label}</option>`
          ).join('')}
        </select>
      </label>
      ${goalField('drawdown_lock', 'Floor locks at', draft.drawdown_lock, 'balance, optional')}
      ${goalField('daily_loss_limit', 'Daily loss limit', draft.daily_loss_limit, 'optional')}
      ${goalField('consistency_pct', 'Consistency', draft.consistency_pct, 'best day max %')}
      ${goalField('min_days', 'Min trading days', draft.min_days, 'optional', '1')}
      ${goalField('monthly_goal', 'Monthly goal', draft.monthly_goal, 'personal, $')}
    </div>
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
 * would render differently — a created or deleted account, an assignment, or
 * changed goals. It is not called on close, so cancelling costs nothing.
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
    <div class="modal modal-sm acct-modal">
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
  let goalDraft = {}
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
   * Trades on one account, vetoes included — `computeStats` and `tickTally`
   * drop them themselves. Progress gets real trades only: a veto has no fill,
   * so it moves no balance.
   */
  const ownTrades = (accountId) => trades.filter((t) => t.account_id === accountId)

  const progressFor = (account) =>
    accountProgress(account, ownTrades(account.id).filter(isRealTrade), isoDay(new Date()).slice(0, 7))

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
        `${button('back', 'Back')}` +
        `${goalsAvailable ? button('goals-start', 'Edit goals') : ''}` +
        `${button('assign-start', 'Assign trades', '')}`
    } else if (mode === 'goals') {
      foot.innerHTML = `${button('back-detail', 'Cancel')}<span class="spacer"></span>${button('goals-save', 'Save goals', '')}`
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

    if (mode === 'list') body.innerHTML = renderList(accounts, counts, vetoCounts, backtest, progressFor)
    else if (mode === 'create') body.innerHTML = renderCreate(draft)
    else if (mode === 'detail') {
      body.innerHTML = renderDetail(current, counts.get(current.id) ?? 0, ownTrades(current.id), progressFor(current))
    } else if (mode === 'goals') body.innerHTML = renderGoals(goalDraft)
    else body.innerHTML = renderAssign(current, trades, picked)

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

  /** The goals form's current values, keyed by column. */
  const readGoals = () => {
    const out = {}
    overlay.querySelectorAll('[data-goal]').forEach((input) => {
      out[input.dataset.goal] = input.value
    })
    return out
  }

  async function saveGoals(btn) {
    goalDraft = readGoals()
    const problem = validateGoals(goalDraft)
    if (problem) return void (err.textContent = problem)

    btn.disabled = true
    try {
      await updateAccountGoals(current.id, normaliseGoals(goalDraft))
      dirty = true
      const id = current.id
      await load()
      current = accounts.find((a) => a.id === id) ?? null
      mode = current ? 'detail' : 'list'
      render()
    } catch (e) {
      fail(e, 'Could not save the goals')
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
    else if (act === 'goals-start') {
      goalDraft = { ...current }
      mode = 'goals'
      render()
    } else if (act === 'goals-save') await saveGoals(btn)
  })

  overlay.addEventListener('change', (e) => {
    // A preset overwrites the rule fields but keeps the firm-agnostic ones —
    // status and the personal monthly goal — so picking one cannot un-pass an
    // account or wipe a goal that is yours rather than the firm's.
    if (e.target.id === 'g-preset') {
      const preset = PROP_PRESETS.find((p) => p.id === e.target.value)
      if (!preset) return
      const { id: _id, label: _label, ...rules } = preset
      goalDraft = { ...readGoals(), ...rules }
      return render()
    }

    // Ticking a box only updates the count on the button; re-rendering the whole
    // picker here would scroll a long list back to the top on every click.
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
