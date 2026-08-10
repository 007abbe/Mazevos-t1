import { esc, explainFailure } from '../../lib/ui-text.js'
import { listTradesForAnalysis } from '../../journal/trades.js'
import { fmtMoney } from '../../journal/stats.js'
import { selectThisWeek, selectToday } from './selection.js'
import { requestReport } from './client.js'
import { listReports, saveReport } from './reports.js'
import { generateReport } from './report.js'

const explain = (error) => explainFailure(error, { prefix: 'Analysis failed' })

/** `2026-07-30 15:30` from the stored `2026-07-30T15:30`. */
const shortDate = (date) => (date ?? '').slice(0, 16).replace('T', ' ')

/**
 * STDV's setups are single letters and read as "Setup B"; MM's are named
 * ("Open-Drive"), so they stand on their own. A trade with neither is untagged.
 */
const setupLabel = (trade) =>
  trade.model === 'MM'
    ? esc(trade.mm_setup ?? '')
    : trade.setup_type
      ? `Setup ${esc(trade.setup_type)}`
      : ''

const tradeRow = (trade, selected) => `
  <label class="pick-row">
    <input type="checkbox" data-id="${esc(trade.id)}"${selected ? ' checked' : ''}>
    <span class="mono pick-num">#${esc(trade.num)}</span>
    <span class="pick-date">${esc(shortDate(trade.date))}</span>
    <span class="pick-dir">${esc(trade.type ?? '')}</span>
    <span class="pick-setup">${setupLabel(trade) || '<span class="muted">untagged</span>'}</span>
    <span class="mono pick-pnl ${trade.pnl >= 0 ? 'ok' : 'bad'}">${esc(fmtMoney(trade.pnl))}</span>
  </label>
`

const historyRow = (row) => {
  const when = new Date(row.created_at).toLocaleString('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  return `
    <details class="history-row">
      <summary>
        <span class="mono">${esc(when)}</span>
        <span class="muted">${esc(row.scope)}</span>
      </summary>
      <pre class="brief">${esc(row.report)}</pre>
    </details>
  `
}

const template = () => `
  <div class="agent-inputs">
    <div class="pick-actions">
      <button type="button" class="ghost" data-act="today">Today</button>
      <button type="button" class="ghost" data-act="week">This week</button>
      <button type="button" class="ghost" data-act="all">All</button>
      <button type="button" class="ghost" data-act="clear">Clear</button>
      <span class="muted" data-role="count">0 selected</span>
    </div>

    <div class="pick-list" data-role="trades"><p class="muted">Loading trades…</p></div>

    <div class="agent-actions">
      <button type="button" data-act="analyze">Analyze selected</button>
      <span class="muted" data-role="status"></span>
    </div>

    <p class="muted">
      Layer 1 computes every number in pure JS. The model interprets those figures and
      never calculates its own — expand the statistics below any report to check it.
    </p>
    <p class="err" data-role="error"></p>
  </div>

  <h3 class="agent-section">Latest report</h3>
  <pre class="brief" data-role="report">No report yet. Select trades and hit Analyze.</pre>

  <details class="stats-block" data-role="stats" hidden>
    <summary>Layer 1 statistics — every number the model was given</summary>
    <pre class="brief" data-role="stats-json"></pre>
  </details>

  <h3 class="agent-section">
    Report history
    <button type="button" class="ghost" data-act="refresh">Refresh</button>
  </h3>
  <div data-role="history"><p class="muted">Loading…</p></div>
`

/** Renders DOM into `el`. */
export function renderDom(el) {
  el.innerHTML = template()

  const $ = (role) => el.querySelector(`[data-role="${role}"]`)
  const analyze = el.querySelector('[data-act="analyze"]')

  /** Every trade available to select, newest first. */
  let trades = []
  /** Ids currently ticked. Kept as a Set so selection survives re-renders. */
  const selected = new Set()

  const setError = (text) => {
    $('error').textContent = text
  }
  const setStatus = (text) => {
    $('status').textContent = text
  }

  const renderCount = () => {
    $('count').textContent = `${selected.size} selected`
  }

  const renderTrades = () => {
    $('trades').innerHTML = trades.length
      ? trades.map((t) => tradeRow(t, selected.has(t.id))).join('')
      : '<p class="muted">No trades logged yet.</p>'
    renderCount()
  }

  const replaceSelection = (picked, emptyMessage) => {
    selected.clear()
    picked.forEach((t) => selected.add(t.id))
    renderTrades()
    setError(picked.length ? '' : emptyMessage)
  }

  async function loadTrades() {
    try {
      trades = await listTradesForAnalysis()
      renderTrades()
    } catch (err) {
      $('trades').innerHTML = `<p class="err">Could not load trades: ${esc(err.message)}</p>`
    }
  }

  async function loadHistory() {
    const target = $('history')
    try {
      const rows = await listReports()
      target.innerHTML = rows.length
        ? rows.map(historyRow).join('')
        : '<p class="muted">No saved reports yet.</p>'
    } catch (err) {
      target.innerHTML = `<p class="err">Could not load reports: ${esc(err.message)}</p>`
    }
  }

  async function runAnalysis() {
    const picked = trades.filter((t) => selected.has(t.id))
    if (!picked.length) {
      setError('Select at least one trade.')
      return
    }

    setError('')
    analyze.disabled = true
    analyze.textContent = 'DOM is thinking…'

    try {
      const result = await generateReport(
        { trades: picked, now: Date.now() },
        { requestReport, saveReport, onProgress: setStatus }
      )

      $('report').textContent = result.report

      // Printed verbatim so the prose can be diffed against its own inputs —
      // this is exactly what was sent to the model.
      $('stats-json').textContent = JSON.stringify(result.stats, null, 1)
      $('stats').hidden = false

      setStatus(
        [
          result.scope,
          result.truncated ? '⚠ report was cut short' : '',
          result.saved ? '' : '⚠ not saved to history',
        ]
          .filter(Boolean)
          .join(' · ')
      )

      if (!result.saved) setError(explain(result.saveError))
      else await loadHistory()
    } catch (err) {
      setStatus('')
      setError(explain(err))
    } finally {
      analyze.disabled = false
      analyze.textContent = 'Analyze selected'
    }
  }

  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')?.dataset.act
    if (!action) return

    const now = Date.now()
    if (action === 'today') replaceSelection(selectToday(trades, now), 'No trades logged today.')
    if (action === 'week') replaceSelection(selectThisWeek(trades, now), 'No trades this week.')
    if (action === 'all') replaceSelection(trades, 'No trades logged yet.')
    if (action === 'clear') replaceSelection([], '')
    if (action === 'analyze') runAnalysis()
    if (action === 'refresh') loadHistory()
  })

  // Ticking a box must not re-render the list — that would collapse the
  // scroll position mid-selection.
  el.addEventListener('change', (event) => {
    const id = event.target.dataset?.id
    if (!id) return
    event.target.checked ? selected.add(id) : selected.delete(id)
    renderCount()
  })

  loadTrades()
  loadHistory()
}
