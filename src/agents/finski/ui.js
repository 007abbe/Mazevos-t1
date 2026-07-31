import { esc, explainFailure } from '../../lib/ui-text.js'
import { listTrades } from '../../journal/trades.js'
import { fetchCalendar } from './calendar.js'
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
      <label>VIX now<input type="number" id="fin-vix" step="0.1" placeholder="18.4"></label>
      <label>VIX prev close<input type="number" id="fin-vix-prev" step="0.1" placeholder="17.9"></label>
      <label>VVIX (optional)<input type="number" id="fin-vvix" step="0.1" placeholder="95"></label>
      <label>ON High (optional)<input type="number" id="fin-on-high" step="0.25" placeholder="price"></label>
      <label>ON Low (optional)<input type="number" id="fin-on-low" step="0.25" placeholder="price"></label>
      <label>Prior close (optional)<input type="number" id="fin-prior-close" step="0.25" placeholder="price"></label>
    </div>

    <div class="agent-actions">
      <button type="button" data-act="generate">Generate brief</button>
      <span class="muted" data-role="status"></span>
    </div>

    <p class="muted">
      VIX from your platform or Google. The calendar fetches automatically and is cached for 60 minutes.
      Model-risk is set by hardcoded rules — never by the model.
    </p>
    <p class="err" data-role="error"></p>
  </div>

  <h3 class="agent-section">Latest brief</h3>
  <div data-role="banner"></div>
  <pre class="brief" data-role="brief">No brief yet. Fill in VIX and hit Generate.</pre>

  <h3 class="agent-section">
    Brief history
    <button type="button" class="ghost" data-act="refresh">Refresh</button>
  </h3>
  <div data-role="history"><p class="muted">Loading…</p></div>
`

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
    const vix = {
      now: numOrNull(el.querySelector('#fin-vix')),
      prev: numOrNull(el.querySelector('#fin-vix-prev')),
    }

    if (vix.now == null || vix.prev == null) {
      setError('Fill in VIX now and VIX previous close.')
      return
    }

    setError('')
    button.disabled = true
    button.textContent = 'Working…'

    try {
      // Trades feed the regime-persistence rule: yesterday's tagged day type.
      const trades = await listTrades({ limit: 100 })

      const result = await generateBrief(
        {
          vix,
          vvix: numOrNull(el.querySelector('#fin-vvix')),
          levels: {
            onHigh: numOrNull(el.querySelector('#fin-on-high')),
            onLow: numOrNull(el.querySelector('#fin-on-low')),
            priorClose: numOrNull(el.querySelector('#fin-prior-close')),
          },
          trades,
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

  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')?.dataset.act
    if (action === 'generate') generate()
    if (action === 'refresh') loadHistory()
  })

  loadHistory()
}
