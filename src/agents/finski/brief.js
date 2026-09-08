/**
 * The brief pipeline: calendar → rules → prose → stored row.
 *
 * The builders are pure and injected-clock; `generateBrief` is the thin I/O
 * sequence over them, with every dependency passed in so it can run against
 * fakes. Nothing here imports Supabase — `ui.js` wires the real calls.
 */

import { computeModelRisk, yesterdayContext } from '../../domain/model-risk.js'
import { etDate } from '../../domain/et-session.js'
import { macroParagraph } from '../../domain/mac/narrative.js'
import { todayUsdEvents } from './calendar.js'

/**
 * Everything the brief was written from, decided locally.
 *
 * @param {object} input
 * @param {Array<object>} input.calendar full weekly feed
 * @param {{now: number|null, prev: number|null}} input.vix
 * @param {number|null} [input.vvix]
 * @param {{onHigh: number|null, onLow: number|null, priorClose: number|null}} [input.levels]
 * @param {Array<object>} [input.trades] for the regime-persistence rule
 * @param {number} input.now epoch ms
 */
export function buildBriefInputs({
  calendar,
  vix,
  vvix = null,
  levels = { onHigh: null, onLow: null, priorClose: null },
  trades = [],
  now,
}) {
  const events = todayUsdEvents(calendar, now)
  const yesterday = yesterdayContext(trades, now)
  const risk = computeModelRisk({ events, vix, vvix, yesterday, now })

  return { events, yesterday, risk, vix, vvix, levels }
}

/**
 * The request body for the Edge Function. Deliberately narrow: only the fields
 * the prompt template reads, with `dt` dropped — the function never compares
 * times, it only reproduces the labels we send it.
 *
 * The mac snapshot is deliberately *not* here. Finski's prompt forbids
 * direction, mac is directional, and the two are reconciled by keeping the
 * macro paragraph out of the model's hands entirely: it is written by
 * `src/domain/mac/narrative.js` and spliced in by `formatBrief` after the model
 * has finished. Sending it here would put a bull/bear read in front of a model
 * told never to have one.
 */
export function toFunctionPayload({ risk, vix, vvix, levels, events, yesterday }) {
  return {
    level: risk.level,
    triggered: risk.triggered,
    vix,
    vvix,
    levels,
    yesterday,
    events: events.map((e) => ({
      title: e.title,
      impact: e.impact,
      timeLabel: e.timeLabel,
      forecast: e.forecast ?? '',
      previous: e.previous ?? '',
    })),
  }
}

/**
 * The `data` column: the inputs a stored brief was written from, so an old
 * brief can be read back against the tape it described.
 */
export function toStoredData({ vix, vvix, levels, events, yesterday, macro = null }) {
  return {
    vix,
    vvix,
    levels,
    yesterday,
    // The regime as it stood when the brief was written, not a live lookup.
    // `macro_snapshots` keeps the full object; this is the slice needed to read
    // an old brief back against the lean it was written under, and it must not
    // change when the snapshot is recomputed.
    macro: macro
      ? {
          date: macro.date,
          version: macro.version,
          bull_pct: macro.l1.bar.bull_pct,
          label: macro.l1.bar.label,
          bias_raw: macro.l1.bias_raw,
          conviction: macro.l1.conviction,
          vol_regime: macro.l2.vol_regime,
        }
      : null,
    events: events.map((e) => ({
      title: e.title,
      impact: e.impact,
      timeET: e.timeET,
      timeCET: e.timeCET,
      timeLabel: e.timeLabel,
      forecast: e.forecast ?? null,
      previous: e.previous ?? null,
    })),
  }
}

/**
 * Header + macro + prose, as stored and displayed. The date is the New York
 * trading date — FlowJournal used the UTC one, which rolls over mid-evening CET
 * and would date an evening-written brief to the following session.
 *
 * The MACRO section sits between the deterministic header and the model's
 * prose, which is exactly where it belongs on both counts: it is deterministic,
 * like the header, and it frames the session before the vol-and-events read
 * that follows. With no snapshot the section is dropped whole, so a day mac
 * could not run produces a brief byte-identical to one written before mac
 * existed.
 */
export function formatBrief({ risk, prose, now, macro = null }) {
  const header = [
    `FINSKI BRIEF — ${etDate(now)}`,
    `MODEL-RISK: ${risk.level}`,
    risk.triggered.length ? `Triggered: ${risk.triggered.join(' | ')}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return [header, macroParagraph(macro), prose].filter(Boolean).join('\n\n')
}

/**
 * Runs the whole pipeline and stores the result.
 *
 * A failed save does not fail the brief — the text is already written and the
 * trader needs it before the open; losing the history row is the lesser cost.
 * The caller is told via `saved`.
 *
 * @returns {Promise<{brief: string, risk: object, events: Array<object>,
 *   fromCache: boolean, stale: boolean, truncated: boolean, saved: boolean,
 *   saveError: Error|null}>}
 */
export async function generateBrief(
  { vix, vvix = null, levels, trades = [], macro = null, now = Date.now() },
  { fetchCalendar, requestBrief, saveBrief, onProgress = () => {} }
) {
  onProgress('Fetching calendar…')
  const calendar = await fetchCalendar()

  const inputs = buildBriefInputs({
    calendar: calendar.events,
    vix,
    vvix,
    levels,
    trades,
    now,
  })

  onProgress('Writing brief…')
  const { prose, truncated = false } = await requestBrief(toFunctionPayload(inputs))

  const brief = formatBrief({ risk: inputs.risk, prose, now, macro })

  let saved = true
  let saveError = null
  try {
    await saveBrief({ risk: inputs.risk, brief, data: toStoredData({ ...inputs, macro }) })
  } catch (err) {
    saved = false
    saveError = err
  }

  return {
    brief,
    risk: inputs.risk,
    events: inputs.events,
    macro,
    fromCache: calendar.fromCache ?? false,
    stale: calendar.stale ?? false,
    truncated,
    saved,
    saveError,
  }
}
