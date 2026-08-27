/**
 * Account types.
 *
 * Unlike the vocabularies in trade-vocab.js, these are not a FlowJournal
 * compatibility contract — accounts are new to Mazevo and FlowJournal has no
 * concept of them. They are still stored strings, so changing a value here
 * means migrating existing `accounts.type` rows.
 *
 * Order is display order: the account you are most committed to first, and
 * Backtest last because no money was ever at stake on it.
 */
export const ACCOUNT_TYPES = ['Live', 'Funded', 'Evaluation', 'Demo', 'Backtest']

export const DEFAULT_ACCOUNT_TYPE = 'Evaluation'

export const isAccountType = (value) => ACCOUNT_TYPES.includes(value)

/**
 * A backtest account is an ordinary account with this type — no column, no
 * second table. That is deliberate: `accounts.type` is already free text
 * specifically so a new kind of account costs no migration, and a boolean flag
 * beside the type would let a row claim to be both a Live account and a
 * backtest one.
 *
 * What the type buys is a hard partition. Trades on a backtest account are the
 * Backtest journal's; every other trade, assigned or not, is the live
 * journal's. Neither one's numbers can leak into the other's tiles.
 */
export const BACKTEST_ACCOUNT_TYPE = 'Backtest'

export const isBacktestAccount = (account) => account?.type === BACKTEST_ACCOUNT_TYPE

/**
 * The set of account ids that belong to the Backtest journal. A Set because
 * every trade row is tested against it once per render.
 */
export const backtestAccountIds = (accounts = []) =>
  new Set(accounts.filter(isBacktestAccount).map((a) => a.id))

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
