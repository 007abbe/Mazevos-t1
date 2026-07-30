/**
 * The DOM pipeline: selection → Layer 1 stats → Layer 2 prose → stored row.
 *
 * The builders are pure; `generateReport` is the thin I/O sequence over them,
 * with dependencies injected so it runs against fakes. Nothing here imports
 * Supabase — `ui.js` wires the real calls.
 */

import { computeTradeStats, rMultiple } from '../../domain/trade-stats.js'
import { describeScope, localDate } from './selection.js'

/**
 * Upper bound on one report, matching the Edge Function's own limit.
 *
 * Enforced here rather than by silently truncating there: the statistics cover
 * the whole selection, so a trimmed notes array would let the model reason
 * about language across fewer trades than the numbers describe — and the
 * "3+ occurrences" rule would be counting against a different corpus than the
 * one the report claims.
 */
export const MAX_ANALYSIS_TRADES = 200

/** Per-trade qualitative record — the trader's own words, lightly structured. */
export function toNotes(trades) {
  return [...trades]
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    .map((t) => {
      const r = rMultiple(t)
      return {
        num: t.num,
        outcome: t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'BE',
        r: r == null ? null : Number(r.toFixed(2)),
        setup: t.setup_type || null,
        band: t.band_touched || null,
        away_stack: !!t.away_stack,
        be_reason: t.be_reason || null,
        rules_broken: t.rule_broken ?? [],
        thesis: (t.thesis || '').slice(0, 400),
        hindsight: (t.hindsight || '').slice(0, 400),
      }
    })
}

/**
 * The request body for the Edge Function.
 *
 * `reportDate` is computed here because only the client knows the trader's
 * local date — the function runs in UTC, and DOM dates a report by the day the
 * trader is reviewing.
 */
export function buildReportPayload({ trades, now }) {
  if (!trades.length) throw new Error('Select at least one trade')
  if (trades.length > MAX_ANALYSIS_TRADES) {
    throw new Error(`Select at most ${MAX_ANALYSIS_TRADES} trades (${trades.length} selected)`)
  }

  return {
    stats: computeTradeStats(trades),
    notes: toNotes(trades),
    scope: describeScope(trades),
    reportDate: localDate(now),
  }
}

/**
 * Runs the pipeline and stores the result.
 *
 * As with Finski, a failed save does not fail the report — the analysis is
 * already written, and losing the history row is the lesser cost. The caller is
 * told via `saved`.
 */
export async function generateReport(
  { trades, now = Date.now() },
  { requestReport, saveReport, onProgress = () => {} }
) {
  const payload = buildReportPayload({ trades, now })

  onProgress(`Crunching numbers on ${trades.length} trades…`)
  const { report, truncated = false } = await requestReport(payload)

  let saved = true
  let saveError = null
  try {
    await saveReport({
      scope: payload.scope,
      tradeIds: trades.map((t) => t.id),
      stats: payload.stats,
      report,
    })
  } catch (err) {
    saved = false
    saveError = err
  }

  return { report, stats: payload.stats, scope: payload.scope, truncated, saved, saveError }
}
