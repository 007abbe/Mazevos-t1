import { esc, explainFailure } from '../../lib/ui-text.js'
import { listTrades } from '../../journal/trades.js'
import { etDate } from '../../domain/et-session.js'
import { snapshotFor } from '../reggie/mac/snapshots.js'
import { fetchCalendar } from './calendar.js'
import { fetchVolQuotes } from './quotes.js'
import { requestBrief } from './client.js'
import { listBriefs, saveBrief } from './briefs.js'
import { generateBrief } from './brief.js'

const numOrNull = (el) => {
  const value = parseFloat(el.value)
  return Number.isNaN(value) ? null : value
}

/** The calendar's own error already names the Action to re-run. */
const explain = (error) =>
  explainFailure(error, { prefix: 'Brief failed', passThrough: [/Calendar unavailable/i] })

const banner = (risk) => `
  <div class="banner banner-${esc(risk.level.toLowerCase())}">
    <div class="banner-level">MODEL-RISK: ${esc(risk.level)}</div>
    ${
      risk.triggered.length
        ? `<ul class="banner-rules">${risk.triggered.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      risk.level === 'LOW'
        ? `<p class="banner-note">LOW = no known scheduled or volatility risk. Trend-day risk cannot be
           assessed pre-market — confirm the regime in the first 15 minutes.</p>`
        : ''
    }
  </div>
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
        <span class="level level-${esc((row.model_risk ?? '').toLowerCase())}">${esc(row.model_risk)}</span>
      </summary>
      <pre class="brief">${esc(row.brief)}</pre>
    </details>
  `
}

const template = () => `
  <div class="agent-inputs">
    <div class="grid">
      <label>VXN now<input type="number" id="fin-vxn" step="0.1" placeholder="22.2"></label>
      <label>VXN prev close<input type="number" id="fin-vxn-prev" step="0.1" placeholder="21.7"></label>
      <label>VVIX (optional)<input type="number" id="fin-vvix" step="0.1" placeholder="95"></label>
      <label>ON High (optional)<input type="number" id="fin-on-high" step="0.25" placeholder="price"></label>
      <label>ON Low (optional)<input type="number" id="fin-on-low" step="0.25" placeholder="price"></label>
      <label>Prior close (optional)<input type="number" id="fin-prior-close" step="0.25" placeholder="price"></label>
    </div>

    <div class="agent-actions">
      <button type="button" data-act="generate">Generate brief</button>
      <span class="muted" data-role="status"></span>
    </div>

    <p class="muted" data-role="vix-source">Fetching VXN…</p>
    <p class="muted">
      The calendar fetches automatically and is cached for 60 minutes.
      Model-risk is set by hardcoded rules — never by the model.
    </p>
    <p class="err" data-role="error"></p>
  </div>

  <h3 class="agent-section">Latest brief</h3>
  <div data-role="banner"></div>
  <pre class="brief" data-role="brief">No brief yet. Fill in VXN and hit Generate.</pre>

  <h3 class="agent-section">
    Brief history
    <button type="button" class="ghost" data-act="refresh">Refresh</button>
  </h3>
  <div data-role="history"><p class="muted">Loading…</p></div>
`

/**
 * Today's mac snapshot, or null.
 *
 * A failure here must never fail the brief. Finski's job is to be on screen
 * before the open; the macro section is an addition to it, not a prerequisite,
 * so a missing table, an unrun mac or a dropped connection all resolve to "no
 * MACRO section" rather than to no brief.
 */
async function macroSnapshot() {
  try {
    return await snapshotFor(etDate(Date.now()))
  } catch {
    return null
  }
}

/** Renders Finski into `el`. */
export function renderFinski(el) {
  el.innerHTML = template()

  const $ = (role) => el.querySelector(`[data-role="${role}"]`)
  const button = el.querySelector('[data-act="generate"]')

  const setStatus = (text) => {
    $('status').textContent = text
  }
  const setError = (text) => {
    $('error').textContent = text
  }

  async function loadHistory() {
    const target = $('history')
    try {
      const rows = await listBriefs()
      target.innerHTML = rows.length
        ? rows.map(historyRow).join('')
        : '<p class="muted">No saved briefs yet.</p>'
    } catch (err) {
      target.innerHTML = `<p class="err">Could not load briefs: ${esc(err.message)}</p>`
    }
  }

  async function generate() {
    const vxn = {
      now: numOrNull(el.querySelector('#fin-vxn')),
      prev: numOrNull(el.querySelector('#fin-vxn-prev')),
    }

    if (vxn.now == null || vxn.prev == null) {
      setError('Fill in VXN now and VXN previous close.')
      return
    }

    setError('')
    button.disabled = true
    button.textContent = 'Working…'

    try {
      // Trades feed the regime-persistence rule: yesterday's tagged day type.
      const trades = await listTrades({ limit: 100 })

      // Read-only: Finski never computes a snapshot, it quotes the one mac
      // stored. If mac has not run today the MACRO section is simply absent —
      // a brief without it is better than a brief that made one up.
      const macro = await macroSnapshot()

      const result = await generateBrief(
        {
          vxn,
          vvix: numOrNull(el.querySelector('#fin-vvix')),
          levels: {
            onHigh: numOrNull(el.querySelector('#fin-on-high')),
            onLow: numOrNull(el.querySelector('#fin-on-low')),
            priorClose: numOrNull(el.querySelector('#fin-prior-close')),
          },
          trades,
          macro,
          now: Date.now(),
        },
        { fetchCalendar, requestBrief, saveBrief, onProgress: setStatus }
      )

      $('banner').innerHTML = banner(result.risk)
      $('brief').textContent = result.brief

      setStatus(
        [
          result.stale ? '⚠ calendar from an expired cache' : '',
          !result.stale && result.fromCache ? 'calendar from cache' : '',
          result.macro ? '' : 'no macro snapshot — run mac in Reggie',
          result.truncated ? '⚠ brief was cut short' : '',
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
      button.disabled = false
      button.textContent = 'Generate brief'
    }
  }

  /**
   * Fills VIX from the live quote, leaving the fields editable.
   *
   * Pre-filled, never locked. Finski refuses to run without a VIX, so a failed
   * quote has to leave a box you can type into rather than block the brief —
   * and a value you disagree with has to be correctable in the moment.
   *
   * Before 09:30 New York the index is not being disseminated, so "now" is
   * openly reported as the previous close instead of being dressed up as live.
   */
  async function fillQuotes() {
    const hint = $('vix-source')
    const { vxn, vvix, failed } = await fetchVolQuotes()

    if (failed || !vxn) {
      hint.className = 'err'
      hint.textContent = `VXN could not be fetched${failed ? ` — ${failed}` : ''}. Type it in.`
      return
    }

    const set = (id, value) => {
      const input = el.querySelector(id)
      // Never overwrite something already typed: the fetch resolves after the
      // panel is interactive, and clobbering a correction mid-keystroke is
      // exactly the behaviour that makes an auto-filled field untrustworthy.
      if (input && !input.value && value != null) input.value = String(value)
    }

    set('#fin-vxn', vxn.value)
    set('#fin-vxn-prev', vxn.prev)
    if (vvix?.value != null) set('#fin-vvix', vvix.value)

    hint.className = 'muted'
    hint.textContent =
      `VXN ${vxn.value ?? '—'} (${vxn.source}, ${vxn.feed ?? 'unknown feed'}), previous close ${vxn.prev ?? '—'}` +
      `${vxn.prev_date ? ` from ${vxn.prev_date}` : ''}` +
      `${vvix?.value != null ? ` · VVIX ${vvix.value}` : ''}. Edit any of these if you disagree.`
  }

  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')?.dataset.act
    if (action === 'generate') generate()
    if (action === 'refresh') loadHistory()
  })

  loadHistory()
  fillQuotes()
}
