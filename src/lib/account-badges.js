import { esc } from './ui-text.js'

/**
 * Account colouring, shared by the journal table, the Accounts UI and the trade
 * form so the four types cannot drift apart on colour.
 *
 * The type *is* the colour: Live purple, Funded green, Evaluation blue, Demo
 * grey. Both the type label and the account's own name take it, so an account
 * is identifiable at a glance without reading the word "Evaluation" — which is
 * the point, since the name is what the table shows.
 *
 * Presentation only, same as trade-badges.js: nothing here decides what a type
 * *is*, it maps a value the row already carries to a class name. The classes
 * resolve to tokens in style.css.
 */

const TYPE_CLASSES = {
  Live: 'acct-live',
  Funded: 'acct-funded',
  Evaluation: 'acct-eval',
  Demo: 'acct-demo',
  // Amber, and shared with the veto badge: both mark a row where no money
  // changed hands, which is the one thing you must never misread at a glance.
  Backtest: 'acct-backtest',
}

/** An unrecognised type takes the neutral grey rather than losing its colour. */
export const accountTypeClass = (type) => TYPE_CLASSES[type] ?? 'acct-demo'

/** The type as a filled pill, e.g. in the account detail panel. */
export const accountTypeBadge = (type) =>
  `<span class="badge acct-badge ${accountTypeClass(type)}">${esc(type ?? '—')}</span>`

/**
 * An account's name in its type's colour. Takes the whole account rather than
 * two arguments so a caller cannot pair one account's name with another's type.
 *
 * Unassigned trades pass null and get an em dash — an uncoloured name would
 * read as a Demo account rather than as no account at all.
 */
export function accountName(account) {
  if (!account) return '<span class="acct-none">—</span>'
  return `<span class="acct-name ${accountTypeClass(account.type)}">${esc(account.name)}</span>`
}
