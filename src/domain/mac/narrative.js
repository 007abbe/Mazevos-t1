/**
 * The MACRO section of the Finski brief.
 *
 * Written here, deterministically, from the snapshot — the LLM never sees it
 * and never writes it. That is not a stylistic preference. Finski's prompt
 * forbids direction outright ("no bullish/bearish, no bias, no targets") and
 * mac is explicitly directional; the only way both can be true is if the
 * directional read reaches the brief as text the model never touched. So this
 * paragraph is assembled next to the numbers that produced it and spliced into
 * the brief after the model has finished, and `toFunctionPayload` still sends
 * the model nothing about it.
 *
 * It follows that every sentence here has to be defensible on its own. No
 * hedging language is added and none is removed: the bar sentence already says
 * "may have a tailwind" rather than a probability, and that wording stays until
 * the validation phase earns the right to change it.
 */

import { QUADRANT_LABELS } from './compose.js'
import { SERIES } from './factors.js'
import { GATING_ENABLED, LOGGING_NOTICE } from './validation.js'

export const MACRO_HEADING = 'MACRO'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** FRED ids read back as the names they are quoted by. */
const EXTRA_LABELS = { ISM_PMI: 'ISM PMI', CALENDAR: 'the event calendar' }
const label = (id) => SERIES[id]?.label ?? EXTRA_LABELS[id] ?? id

const list = (heading, items) =>
  items.length ? `${heading}:\n${items.map((item) => `  - ${item}`).join('\n')}` : null

/**
 * The context line under the bar sentence: which quadrant, how much agreement,
 * and how long this has held.
 *
 * Age is the part traders under-weight. A lean that appeared this morning and
 * one that has survived two weeks of prints are the same number and completely
 * different information, so the brief always says which it is.
 */
function contextLine(snapshot) {
  const { l1 } = snapshot
  const parts = []

  const quadrantText = QUADRANT_LABELS[l1.quadrant]
  if (quadrantText) parts.push(quadrantText)

  parts.push(`${l1.conviction} conviction (${l1.conviction_agreeing}/6 factors agree)`)

  const age = l1.regime_age_days
  parts.push(age === 0 ? 'new today' : `held ${plural(age, 'session')}`)

  if (l1.regime?.pending) {
    parts.push(`${l1.regime.pending} pending (${l1.regime.pending_streak}/3)`)
  }

  return `${parts.join(' · ')}.`
}

const DAY_TYPES = {
  tier1_event: 'Tier 1 event day',
  tier2_event: 'Tier 2 event day',
  auction_day: 'Auction day',
  quarter_end: 'Quarter end',
  normal: 'Normal day',
}

/**
 * The sizing line. Separate from the bar sentence because it governs size
 * rather than direction, and because it is the one part of mac that is allowed
 * to change what you do today.
 *
 * Emitted whenever anything is capped — by vol, by an event, or by both. The
 * cap is the minimum of the two, never the product: two reasons to be careful
 * mean take the more careful one, not a quarter-size position.
 */
function sizingLine(snapshot) {
  const { l2 } = snapshot
  const capped = l2.size_cap < 1
  if (!capped && l2.vol_regime === 'calm' && !l2.day_type) return null

  const context = [
    l2.vol_regime === 'calm' ? null : `vol ${l2.vol_regime}`,
    l2.day_type && l2.day_type !== 'normal' ? DAY_TYPES[l2.day_type] : null,
  ].filter(Boolean)

  const caps = [
    `size cap ${Math.round(l2.size_cap * 100)}%`,
    l2.spm_allowed ? null : 'SPM disabled',
    l2.mm_preferred ? 'MM preferred' : null,
  ].filter(Boolean)

  if (!context.length) return null

  // The cap is stated and then immediately disowned while mac is still being
  // validated. A brief that prints "size cap 50%" with no qualifier is an
  // instruction, and following it is what contaminates the sample Phase 4 needs.
  const suffix = GATING_ENABLED ? '' : ` (${LOGGING_NOTICE})`
  return `${context.join(' · ')} — ${caps.join(', ')}.${suffix}`
}

/** Windows to sit out, with the release that causes each. */
function blackoutLine(snapshot) {
  const windows = snapshot.l2?.no_trade_windows ?? []
  if (!windows.length) return null

  return `No-trade windows (ET):\n${windows
    .map((w) => `  - ${w.from}–${w.to} — ${w.why}`)
    .join('\n')}`
}

/**
 * Scheduled events, and how far the calendar actually reached.
 *
 * The horizon note is not padding. ForexFactory publishes only the current
 * week, so by Thursday this list covers two sessions rather than five — and a
 * short list that does not say it is short reads exactly like a quiet week.
 */
function eventLines(snapshot) {
  const { l2 } = snapshot
  if (!l2 || !l2.horizon_sessions) return null

  const events = l2.events_next_5 ?? []
  const head = events.length
    ? `Scheduled (${l2.horizon_sessions} session${l2.horizon_sessions === 1 ? '' : 's'} ahead):\n${events
        .map(
          (e) =>
            `  - ${e.date} ${e.timeLabel} — ${e.title}` +
            `${e.tier ? ` [tier ${e.tier}]` : ''}${e.forecast ? ` fcst ${e.forecast}` : ''}`
        )
        .join('\n')}`
    : `Scheduled: nothing in the next ${l2.horizon_sessions} session${
        l2.horizon_sessions === 1 ? '' : 's'
      }.`

  const note = l2.horizon_truncated
    ? `\n  (calendar ends ${l2.horizon_ends} — the feed only carries this week, so anything beyond it is unchecked)`
    : ''

  return `${head}${note}`
}

/**
 * Missing, stale and carried-forward inputs, named.
 *
 * This is the line that keeps the rest of the paragraph honest. A carried state
 * reads exactly like a fresh one once it is a number on a bar, so if anything
 * was carried the brief says which factor and why, and the reader can discount
 * it themselves.
 */
function healthLine(snapshot) {
  const { missing, stale, carried } = snapshot.data_health ?? {}
  const notes = []

  if (missing?.length) notes.push(`missing ${missing.map(label).join(', ')}`)
  if (stale?.length) notes.push(`stale ${stale.map(label).join(', ')}`)
  if (carried?.length) notes.push(`carried forward: ${carried.join(', ')}`)

  return notes.length ? `⚠ Data health — ${notes.join('; ')}.` : null
}

/**
 * The MACRO paragraph, or null when there is no snapshot.
 *
 * Null rather than a placeholder is deliberate: `formatBrief` drops the whole
 * section, so a day mac could not run produces a brief identical to one written
 * before mac existed, instead of a heading followed by an apology.
 *
 * @param {object|null} snapshot
 * @returns {string|null}
 */
export function macroParagraph(snapshot) {
  if (!snapshot?.l1?.bar?.sentence) return null

  const blocks = [
    `${MACRO_HEADING} (${snapshot.version} · ${snapshot.date})`,
    snapshot.l1.bar.sentence,
    contextLine(snapshot),
    sizingLine(snapshot),
    blackoutLine(snapshot),
    list('Headwinds', snapshot.l1.headwinds ?? []),
    list('Tailwinds', snapshot.l1.tailwinds ?? []),
    list('Watch', snapshot.l1.watch ?? []),
    eventLines(snapshot),
    healthLine(snapshot),
  ]

  return blocks.filter(Boolean).join('\n')
}

/**
 * The one-line version, for the Reggie card header and anywhere a full
 * paragraph does not fit.
 */
export function macroHeadline(snapshot) {
  if (!snapshot?.l1?.bar) return null
  const { bull_pct, bear_pct, label_text } = snapshot.l1.bar
  return `${bull_pct}/${bear_pct} — ${label_text}`
}
