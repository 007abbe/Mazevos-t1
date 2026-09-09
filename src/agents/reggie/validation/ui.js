import { esc } from '../../../lib/ui-text.js'
import { GATING_ENABLED, MIN_BUCKET_N, validationReport } from '../../../domain/mac/validation.js'
import { listTradesForAnalysis } from '../../../journal/trades.js'

/**
 * Phase 4: the regime held against the record.
 *
 * This page will say "not enough data" for months, and that is the correct
 * output rather than a failure of it. Every table reports its own `n` so a
 * two-trade cell reads as two trades and not as a finding.
 *
 * It no longer reads snapshots or NDX closes. The calibration curve those fed
 * has moved to `scripts/backtest.mjs`, which answers the same question over
 * 2,582 point-in-time sessions rather than the sixty this could gather in three
 * months. What is left needs trades, and only trades.
 */

const r = (value) => (value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`)
const pct = (value) => (value == null ? '—' : `${value}%`)

const VERDICT_CLASS = {
  separated: 'ok',
  no_separation: 'bad',
  insufficient: 'muted',
}

const banner = () => `
  <div class="banner ${GATING_ENABLED ? 'banner-low' : 'banner-elevated'}">
    <div class="banner-level">${GATING_ENABLED ? 'GATING ENABLED' : 'LOGGING PHASE — DISPLAY ONLY'}</div>
    <p class="banner-note">
      ${
        GATING_ENABLED
          ? 'mac is permitted to gate size in the router. This was a deliberate flip backed by the tables below.'
          : `mac's size caps are shown but must not be acted on. Sizing off them now makes hostile
             sessions systematically smaller and more selective, and the tables below would then be
             measuring your compliance with mac rather than the regime's effect. Fix definitions,
             never trades.`
      }
    </p>
  </div>
`

const verdictRow = (title, verdict) => `
  <div class="val-verdict">
    <span class="val-verdict-title">${esc(title)}</span>
    <span class="${VERDICT_CLASS[verdict.state] ?? 'muted'}">${esc(verdict.text)}</span>
  </div>
`

const splitTable = (title, split) => `
  <div class="val-block">
    <h4>${esc(title)}</h4>
    ${
      split.total === 0
        ? `<p class="muted">No ${esc(split.model)} trades logged.</p>`
        : `<table class="val-table">
            <thead><tr><th>Bucket</th><th>n</th><th>Expectancy</th><th>Win rate</th></tr></thead>
            <tbody>
              ${split.rows
                .map(
                  (row) => `<tr class="${row.enough ? '' : 'val-thin'}">
                    <td>${esc(row.bucket)}</td>
                    <td class="mono">${row.n}${row.enough ? '' : `/${MIN_BUCKET_N}`}</td>
                    <td class="mono">${esc(r(row.r))}</td>
                    <td class="mono">${esc(pct(row.win_rate))}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
          ${
            split.unstamped
              ? `<p class="muted">${split.unstamped} of ${split.total} ${esc(split.model)} trades
                 predate mac and carry no regime — they are excluded, not counted as neutral.</p>`
              : ''
          }`
    }
  </div>
`

const reportView = (report) => `
  ${banner()}

  <h3 class="agent-section">Verdicts</h3>
  ${verdictRow('Does the environment separate STDV?', report.verdicts.stdv_env)}
  ${verdictRow('Does the environment separate MM?', report.verdicts.mm_env)}
  ${verdictRow('Does hostile vol hurt STDV?', report.verdicts.stdv_vol)}
  ${verdictRow('Does the bar separate MM?', report.verdicts.mm_bias)}
  <p class="muted">
    A screen, not a significance test. At these sample sizes a p-value would lend an
    authority the data does not have.
  </p>
  <p class="muted">
    The bar was replayed over 2,582 point-in-time sessions and separated nothing against
    the index — bull minus bear came to −2.3bps, with the two halves of the sample
    disagreeing in sign. It is still measured here because the column is stamped anyway
    and your intraday setups are not the index, but mac no longer claims it.
    <strong>The environment rows are the live question.</strong>
  </p>

  <h3 class="agent-section">Trade separation</h3>
  <div class="val-grid">
    ${splitTable('STDV by environment', report.splits.stdv_env)}
    ${splitTable('MM by environment', report.splits.mm_env)}
    ${splitTable('STDV by vol regime', report.splits.stdv_vol)}
    ${splitTable('MM by vol regime', report.splits.mm_vol)}
    ${splitTable('MM by bar label', report.splits.mm_bias)}
    ${splitTable('STDV by bar label', report.splits.stdv_bias)}
  </div>
`

/** Renders the validation panel into `el`. */
export function renderValidation(el) {
  el.innerHTML = `
    <div class="agent-actions">
      <button type="button" data-act="refresh">Run report</button>
      <span class="muted" data-role="status"></span>
    </div>
    <div data-role="report"><p class="muted">Loading…</p></div>
  `

  const $ = (role) => el.querySelector(`[data-role="${role}"]`)

  async function load() {
    $('status').textContent = 'Reading journal and snapshots…'

    try {
      // Live trades only. Backtest rows are excluded upstream by
      // `listTradesForAnalysis` — letting simulated entries into an expectancy
      // test would breach the exact boundary that scope exists to hold.
      const trades = await listTradesForAnalysis({ limit: 2000 })
      const report = validationReport({ trades })

      $('report').innerHTML = reportView(report)
      $('status').textContent = ''
    } catch (err) {
      $('report').innerHTML = `<p class="err">Could not build the report: ${esc(err.message)}</p>`
      $('status').textContent = ''
    }
  }

  el.addEventListener('click', (event) => {
    if (event.target.closest('[data-act="refresh"]')) load()
  })

  load()
}
