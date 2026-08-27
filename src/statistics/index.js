import { defineAgent } from '../agents/contract.js'
import { listTrades } from '../journal/trades.js'
import { listAccounts } from '../journal/accounts.js'
import { byScope, SCOPES } from '../journal/filters.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { isRealTrade } from '../domain/veto-vocab.js'
import { computeStats, fmtMoney, fmtNum } from '../journal/stats.js'
import { computeStatistics } from './compute.js'
import { publishSummary } from '../lib/summary.js'
import { directionBadge, statusBadge } from '../lib/trade-badges.js'
import { esc, explainFailure } from '../lib/ui-text.js'

/**
 * Performance overview. Reads the same `listTrades` the journal does and does
 * every calculation in `compute.js` — no new queries, no new columns.
 *
 * Each block below is one `renderX(stats)` returning a string. Adding a block
 * is a function here plus a key in `computeStatistics`.
 */

const money = (n) => (n === null ? '—' : fmtMoney(n))
const tone = (n) => (n === null ? 'neu' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu')

const statCard = (label, value, cls = 'neu') => `
  <div class="stat-card">
    <div class="stat-label">${label}</div>
    <div class="stat-val ${cls}">${value}</div>
  </div>
`

function renderTotals({ totals }) {
  return `
    <div class="stats-grid">
      ${statCard('Total trades', totals.total)}
      ${statCard('Winners', totals.wins, 'pos')}
      ${statCard('Losers', totals.losses, 'neg')}
      ${statCard('Breakeven', totals.breakeven)}
    </div>
  `
}

function renderPairs({ extremes, averages }) {
  return `
    <div class="pair-grid">
      ${statCard('Best trade', money(extremes.best), tone(extremes.best))}
      ${statCard('Worst trade', money(extremes.worst), tone(extremes.worst))}
      ${statCard('Avg winner', money(averages.avgWinner), tone(averages.avgWinner))}
      ${statCard('Avg loser', money(averages.avgLoser), tone(averages.avgLoser))}
      ${statCard('Avg RR', averages.avgRr === null ? '—' : `${fmtNum(averages.avgRr)}R`)}
      ${statCard('Profit factor', fmtNum(averages.profitFactor))}
    </div>
  `
}

/**
 * Bars are scaled against the largest absolute cumulative value, so a curve
 * that dips negative and recovers keeps both halves readable. Height is capped
 * at the chart's own height in CSS; the minimum keeps a near-zero bar visible.
 */
function renderChart({ curve }) {
  if (!curve.length) {
    return `<section class="panel">
      <h2 class="panel-title">Cumulative P&amp;L</h2>
      <p class="muted">No trades yet.</p>
    </section>`
  }

  const peak = Math.max(...curve.map((p) => Math.abs(p.cumulative)), 1)

  const bars = curve
    .map((p) => {
      const height = Math.max(4, Math.round((Math.abs(p.cumulative) / peak) * 100))
      const cls = p.cumulative >= 0 ? 'up' : 'down'
      const title = `NQ #${esc(p.num ?? '?')} · ${fmtMoney(p.cumulative)}`
      return `<div class="chart-bar ${cls}" style="height:${height}%" title="${title}"></div>`
    })
    .join('')

  return `
    <section class="panel">
      <h2 class="panel-title">Cumulative P&amp;L</h2>
      <div class="chart">${bars}</div>
    </section>
  `
}

const breakdownRow = (row, pill) => `
  <div class="break-row">
    ${pill}
    <span class="break-meta">
      ${row.count} trade${row.count === 1 ? '' : 's'}${
        row.winRate === null ? '' : ` · ${row.winRate}% WR`
      }
    </span>
    <span class="break-pnl ${row.pnl >= 0 ? 'ok' : 'bad'}">${fmtMoney(row.pnl)}</span>
  </div>
`

function renderBreakdowns({ byDirection, byStatus }) {
  return `
    <div class="pair-grid">
      <section class="panel">
        <h2 class="panel-title">By direction</h2>
        ${byDirection.map((row) => breakdownRow(row, directionBadge(row.label))).join('')}
      </section>
      <section class="panel">
        <h2 class="panel-title">By status</h2>
        ${byStatus.map((row) => breakdownRow(row, statusBadge(row.label))).join('')}
      </section>
    </div>
  `
}

/** An R value with its sign kept, or an em dash. Signs matter on this page. */
const rValue = (r) => (r === null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`)

/** Points are whole-ish numbers on NQ; one decimal is enough to see a quarter. */
const pts = (n) => (n === null ? '—' : `${n.toFixed(1)} pts`)

/** The sample a number rests on, shown beside it rather than hidden in a title. */
const sample = (n) => `<span class="row-n">n=${n}</span>`

const auditRow = (label, value, cls, n, note) => `
  <div class="break-row audit-row">
    <span class="audit-label">${label}${note ? `<span class="audit-note">${note}</span>` : ''}</span>
    <span class="break-meta">${sample(n)}</span>
    <span class="break-pnl ${cls}">${value}</span>
  </div>
`

/**
 * The discretion audit, as two panels that must never be read as one number.
 *
 * Left: does judgement pay, where the mechanical model *did* fire — mean actual
 * R minus mean mechanical R.
 *
 * Right: what the entries the model would *not* have taken actually return.
 * That figure stays on its own. Blended into a headline expectancy it
 * disappears: a book of good mechanical trades will carry a bleeding
 * discretionary habit inside one flattering average for a very long time.
 */
function renderDiscretion({ discretion, mech }) {
  const { delta, n, avgActualR, avgMechR, tagged } = discretion
  const deltaCls = delta === null ? 'neu' : delta > 0 ? 'ok' : delta < 0 ? 'bad' : ''

  const empty = `<p class="muted">Nothing audited yet. Answer <b>mech trigger</b> on an entry —
    and record a counterfactual R when it was <b>yes</b> — to fill this in.</p>`

  return `
    <div class="pair-grid">
      <section class="panel">
        <h2 class="panel-title">Discretion delta</h2>
        ${
          delta === null
            ? empty
            : `
          <div class="audit-headline ${deltaCls}">${rValue(delta)}</div>
          <p class="muted audit-explain">
            You averaged <b>${rValue(avgActualR)}</b> where a strict mechanical run would have
            averaged <b>${rValue(avgMechR)}</b>, across ${n} entr${n === 1 ? 'y' : 'ies'} the model fired on.
            ${delta > 0 ? 'Your judgement paid.' : delta < 0 ? 'The model was right and you were expensive.' : 'Exactly neutral.'}
          </p>
          ${
            tagged > n
              ? `<p class="muted audit-explain">${tagged - n} more answered “yes” but recorded no counterfactual R.</p>`
              : ''
          }`
        }
      </section>

      <section class="panel">
        <h2 class="panel-title">Deviation cost</h2>
        <p class="muted audit-explain">
          Expectancy by whether a strict mechanical run would have fired. Kept apart on purpose —
          these are never blended into one headline number.
        </p>
        ${auditRow('Deviation', rValue(mech.deviation.r), mech.deviation.r === null ? 'neu' : mech.deviation.r >= 0 ? 'ok' : 'bad', mech.deviation.n, 'mech said no')}
        ${auditRow('Mechanical', rValue(mech.fired.r), mech.fired.r === null ? 'neu' : mech.fired.r >= 0 ? 'ok' : 'bad', mech.fired.n, 'mech said yes')}
        ${auditRow('Partial', rValue(mech.partial.r), mech.partial.r === null ? 'neu' : mech.partial.r >= 0 ? 'ok' : 'bad', mech.partial.n, 'signal half-formed')}
        ${auditRow('Not audited', rValue(mech.untagged.r), 'neu', mech.untagged.n, 'no answer yet')}
      </section>
    </div>
  `
}

/**
 * Stop and target distances in points — what the chart looked like, independent
 * of how big you were. See src/domain/points.js for why targets are measured on
 * winners only.
 */
function renderPoints({ points }) {
  const { avgStop, stopN, minStop, maxStop, avgTarget, targetN, ratio } = points

  if (!stopN && !targetN) {
    return `<section class="panel">
      <h2 class="panel-title">Distances</h2>
      <p class="muted">No entry prices recorded yet. Fill in <b>Entry price</b> and
        <b>Planned stop</b> on a trade and the distances appear here.</p>
    </section>`
  }

  return `
    <section class="panel">
      <h2 class="panel-title">Distances</h2>
      <div class="stats-grid">
        ${statCard(`Avg stop ${sample(stopN)}`, pts(avgStop))}
        ${statCard(`Avg take profit ${sample(targetN)}`, pts(avgTarget), 'pos')}
        ${statCard('Tightest stop', pts(minStop))}
        ${statCard('Widest stop', pts(maxStop))}
      </div>
      <p class="muted audit-explain">
        Realised reward-to-risk in points: <b>${ratio === null ? '—' : `${ratio.toFixed(2)}×`}</b>.
        Take profit is measured on winners only — the distance to a stopped-out exit is a stop, not a target.
      </p>
    </section>
  `
}

const BLOCKS = [renderTotals, renderPairs, renderChart, renderPoints, renderDiscretion, renderBreakdowns]

export const statistics = defineAgent({
  id: 'statistics',
  title: 'Statistics',
  subtitle: 'Performance overview',

  async mount(el) {
    el.innerHTML = `<p class="muted">Loading trades…</p>`

    let all
    let accounts
    try {
      ;[all, accounts] = await Promise.all([listTrades(), listAccounts()])
    } catch (err) {
      el.innerHTML = `<p class="err">${esc(explainFailure(err, { prefix: 'Could not load trades' }))}</p>`
      return
    }

    // This page is "how am I actually doing", so it answers over executed
    // trades only. Backtest entries were never filled and vetoes were never
    // taken — including either would put a cumulative P&L curve on screen that
    // no account ever earned. The Backtest journal has its own tiles for the
    // first; the discretion delta there is where the second pays off.
    const live = byScope(all, SCOPES.LIVE, backtestAccountIds(accounts))
    const trades = live.filter(isRealTrade)

    // The sidebar footer reads the same totals the journal publishes, so
    // landing here first still fills it in.
    publishSummary(computeStats(trades))

    // `live` rather than `trades` for the audit: a veto is a decision worth
    // exactly 0R, and dropping it would delete the times you talked yourself
    // out of a signal the model called correctly. Every other block on the page
    // is a P&L block and gets executed trades only.
    const stats = computeStatistics(trades, live)
    el.innerHTML = BLOCKS.map((render) => render(stats)).join('')
  },
})
