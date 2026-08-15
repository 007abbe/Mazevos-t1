/**
 * Account types.
 *
 * Unlike the vocabularies in trade-vocab.js, these are not a FlowJournal
 * compatibility contract — accounts are new to Mazevo and FlowJournal has no
 * concept of them. They are still stored strings, so changing a value here
 * means migrating existing `accounts.type` rows.
 *
 * Order is display order: the account you are most committed to first.
 */
export const ACCOUNT_TYPES = ['Live', 'Funded', 'Evaluation', 'Demo']

export const DEFAULT_ACCOUNT_TYPE = 'Evaluation'

export const isAccountType = (value) => ACCOUNT_TYPES.includes(value)

/**
 * Names are what the trader types, so they need a bound: the value is rendered
 * in a table cell and two dropdowns, and an unbounded string would blow the
 * column width out. Trimmed before length is checked, so whitespace alone is
 * not a name.
 */
export const ACCOUNT_NAME_MAX = 40
export const ACCOUNT_NOTE_MAX = 280

/**
 * Validates a new or edited account. Returns an error message, or null when the
 * account is saveable — the form renders the message, it does not decide it.
 *
 * `existingNames` makes duplicates an error rather than leaving two accounts
 * the dropdown cannot tell apart. Compared case-insensitively: "Eval1" and
 * "eval1" are the same account to a reader.
 */
export function validateAccount({ name, type }, existingNames = []) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return 'Give the account a name'
  if (trimmed.length > ACCOUNT_NAME_MAX) return `Keep the name under ${ACCOUNT_NAME_MAX} characters`
  if (!isAccountType(type)) return 'Pick an account type'

  const taken = existingNames.some((n) => String(n).trim().toLowerCase() === trimmed.toLowerCase())
  if (taken) return `You already have an account called “${trimmed}”`

  return null
}
