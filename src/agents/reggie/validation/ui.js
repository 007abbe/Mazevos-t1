import { esc } from '../../../lib/ui-text.js'
import {
  GATING_ENABLED,
  MIN_BUCKET_N,
  MIN_CALIBRATION_SESSIONS,
  validationReport,
} from '../../../domain/mac/validation.js'
import { SERIES } from '../../../domain/mac/factors.js'
import { listTradesForAnalysis } from '../../../journal/trades.js'
import { fetchSeries } from '../mac/client.js'
import { listSnapshots } from '../mac/snapshots.js'

/**
 * Phase 4: the regime held against the record.
 *
 * This page will say "not enough data" for months, and that is the correct
 * output rather than a failure of it. Every table reports its own `n` so a
 * two-trade cell reads as two trades and not as a finding.
 */

const SESSION_LIMIT = 400

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

/**
 * The calibration curve as a table rather than a chart.
 *
 * A five-point line drawn from buckets holding four sessions each would look
 * like a trend. The numbers, with their counts beside them, cannot.
 */
const calibrationTable = (calibration) => `
  <div class="val-block">
    <h4>Bar calibration — ${calibration.sessions} session${calibration.sessions === 1 ? '' : 's'}</h4>
    <p class="muted">
      What the bar predicted against the share of those sessions that actually closed green.
      Needs no trades — one point per session, from stored snapshots against NDX closes.
      ${
        calibration.enough
          ? 'Enough sessions to refit the ×6 scale.'
          : `${MIN_CALIBRATION_SESSIONS - calibration.sessions} more sessions before the ×6 scale
             is worth refitting. Until then the bar stays a lean, never a probability.`
      }
    </p>
    <table class="val-table">
      <thead><tr><th>bull_pct</th><th>n</th><th>Predicted</th><th>Actual green</th></tr></thead>
      <tbody>
        ${calibration.buckets
          .map(
            (bucket) => `<tr class="${bucket.enough ? '' : 'val-thin'}">
              <td>${esc(bucket.label)}</td>
              <td class="mono">${bucket.n}</td>
              <td class="mono">${bucket.predicted}%</td>
              <td class="mono">${esc(pct(bucket.actual))}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>
`

const reportView = (report) => `
  ${banner()}

  <h3 class="agent-section">Verdicts</h3>
  ${verdictRow('Does hostile vol hurt STDV?', report.verdicts.stdv_vol)}
  ${verdictRow('Does the bar separate MM?', report.verdicts.mm_bias)}
  <p class="muted">
    A screen, not a significance test. At these sample sizes a p-value would lend an
    authority the data does not have.
  </p>

  <h3 class="agent-section">Calibration</h3>
  ${calibrationTable(report.calibration)}

  <h3 class="agent-section">Trade separation</h3>
  <div class="val-grid">
    ${splitTable('STDV by vol regime', report.splits.stdv_vol)}
    ${splitTable('MM by bar label', report.splits.mm_bias)}
    ${splitTable('STDV by bar label', report.splits.stdv_bias)}
    ${splitTable('MM by vol regime', report.splits.mm_vol)}
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
      const [trades, snapshots, fred] = await Promise.all([
        listTradesForAnalysis({ limit: 2000 }),
        listSnapshots(SESSION_LIMIT),
        fetchSeries([SERIES.NASDAQ100.id]).catch(() => null),
      ])

      const closes = fred?.series?.[SERIES.NASDAQ100.id] ?? []
      const report = validationReport({ trades, snapshots, closes })

      $('report').innerHTML = reportView(report)
      $('status').textContent = closes.length ? '' : '⚠ no NDX closes — calibration unavailable'
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
