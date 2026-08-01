import { defineAgent } from '../agents/contract.js'
import { listTrades } from '../journal/trades.js'
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

const BLOCKS = [renderTotals, renderPairs, renderChart, renderBreakdowns]

export const statistics = defineAgent({
  id: 'statistics',
  title: 'Statistics',
  subtitle: 'Performance overview',

  async mount(el) {
    el.innerHTML = `<p class="muted">Loading trades…</p>`

    let trades
    try {
      trades = await listTrades()
    } catch (err) {
      el.innerHTML = `<p class="err">${esc(explainFailure(err, { prefix: 'Could not load trades' }))}</p>`
      return
    }

    // The sidebar footer reads the same totals the journal publishes, so
    // landing here first still fills it in.
    publishSummary(computeStats(trades))

    const stats = computeStatistics(trades)
    el.innerHTML = BLOCKS.map((render) => render(stats)).join('')
  },
})
