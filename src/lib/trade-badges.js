import { esc } from './ui-text.js'

/**
 * Status and direction pills, shared by the journal table and the Statistics
 * breakdowns so the two cannot drift apart on colour.
 *
 * Ported from FlowJournal's `badgeHTML` and `dirBadgeHTML`
 * (trading-journal/index.html:2199 and :2193). It reuses the status classes for
 * direction — Long renders as `badge-tp`, Short as `badge-sl`. The names below
 * say what they mean instead; both resolve to the same tokens, so the rendered
 * colour is identical.
 *
 * Presentation only. Nothing here decides what a status *is* — it maps a value
 * the row already carries to a class name.
 */

const STATUS_CLASSES = {
  TP: 'badge-tp',
  SL: 'badge-sl',
  BE: 'badge-be',
  'TP1+BE': 'badge-mixed',
  Open: 'badge-open',
}

/** Unrecognised statuses take the neutral pill rather than disappearing. */
export const statusBadgeClass = (status) => STATUS_CLASSES[status] ?? 'badge-be'

export const directionBadgeClass = (direction) =>
  direction === 'Long' ? 'badge-long' : direction === 'Short' ? 'badge-short' : 'badge-be'

/**
 * A pill, or an em dash when there is nothing to show — an empty pill reads as
 * a rendering bug rather than as missing data.
 */
export function badge(label, className) {
  if (label === null || label === undefined || label === '') return '—'
  return `<span class="badge ${className}">${esc(label)}</span>`
}

export const statusBadge = (status) => badge(status, statusBadgeClass(status))
export const directionBadge = (direction) => badge(direction, directionBadgeClass(direction))
