import { supabase } from '../lib/supabase.js'
import { getUser } from '../lib/auth.js'

/**
 * Reads and writes for the `accounts` table.
 *
 * Same shape as trades.js: cloud-first, RLS scopes rows to the signed-in user
 * so no query filters on user_id, and inserts still set it because the column
 * is not null and the insert policy checks it.
 */

const COLUMNS = 'id, user_id, type, name, note, created_at'

/** DB row -> app account. */
const fromRow = (r) => ({
  id: r.id,
  type: r.type,
  name: r.name,
  note: r.note || '',
  createdAt: r.created_at,
})

/**
 * Every account, oldest first — the order they were created is the order the
 * trader thinks of them in, and it keeps the dropdown from reshuffling.
 */
export async function listAccounts() {
  const { data, error } = await supabase
    .from('accounts')
    .select(COLUMNS)
    .order('created_at', { ascending: true })

  if (error) throw error
  return (data ?? []).map(fromRow)
}

export async function createAccount({ name, type, note }) {
  const user = await getUser()
  if (!user) throw new Error('Not signed in')

  const { data, error } = await supabase
    .from('accounts')
    .insert({
      user_id: user.id,
      name: String(name).trim(),
      type,
      note: String(note ?? '').trim() || null,
    })
    .select(COLUMNS)
    .single()

  if (error) throw error
  return fromRow(data)
}

/**
 * Deletes the account only. Trades logged on it keep their row and lose their
 * `account_id` — the foreign key is `on delete set null`, so this is enforced
 * by the database rather than by a second statement that could half-fail.
 *
 * Nothing here confirms; the caller shows the trade count first.
 */
export async function deleteAccount(id) {
  const { error } = await supabase.from('accounts').delete().eq('id', id)
  if (error) throw error
}

/**
 * How many trades sit on each account, as a Map keyed by account id, with
 * unassigned trades under the `null` key.
 *
 * Counted from trades already in memory rather than queried. A `select
 * account_id` over the whole table would be the exact number, but the panel
 * showing this count also shows P&L computed from the loaded window — an exact
 * count beside a windowed total is a panel that contradicts itself. This way
 * every number in the Accounts UI describes the same set of trades the journal
 * behind it is showing.
 */
export function countTradesByAccount(trades) {
  const counts = new Map()
  for (const t of trades) {
    const key = t.account_id ?? null
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Points the given trades at `accountId`.
 *
 * `updated_at` is stamped because it is FlowJournal's last-write-wins merge key
 * — see the note in mapping.js. Leaving it untouched would let FlowJournal's
 * stale local copy win and blank the assignment back out. Epoch milliseconds,
 * never a timestamp.
 *
 * Refuses to touch a trade that already has an account: the assign UI only
 * offers unassigned trades, and the `is('account_id', null)` guard makes that a
 * rule rather than a UI convention — a stale checkbox list cannot reassign a
 * trade out from under another account.
 */
export async function assignTradesToAccount(tradeIds, accountId) {
  const ids = [...new Set(tradeIds)].filter(Boolean)
  if (!ids.length) return 0

  const { data, error } = await supabase
    .from('trades')
    .update({ account_id: accountId, updated_at: Date.now() })
    .in('id', ids)
    .is('account_id', null)
    .select('id')

  if (error) throw error
  return (data ?? []).length
}

/*
 * ---- Remembered choices ----
 *
 * Two separate keys, because they answer different questions and a shared one
 * would cross them: the journal's filter can be "unassigned", which is not
 * something a new trade can default to.
 *
 * Both are conveniences over an id that may since have been deleted, so every
 * read is validated against the accounts that actually exist. localStorage is
 * also per-browser, which is the right scope for both — this is UI state, not
 * data, and nothing is lost if it is missing.
 */

const FILTER_KEY = 'mazevo.journal.account'
const LAST_USED_KEY = 'mazevo.lastAccount'

/**
 * Both preferences are per-journal: the account you were last looking at in the
 * Backtest journal is not the one you want restored in the live one, and a
 * shared key would have each page fight the other for it.
 *
 * The live journal keeps the bare key it has always used, so nothing already in
 * a trader's localStorage is orphaned by this change.
 */
const scoped = (key, scope) => (scope && scope !== 'live' ? `${key}.${scope}` : key)

const read = (key) => {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

const write = (key, value) => {
  try {
    value ? localStorage.setItem(key, value) : localStorage.removeItem(key)
  } catch {
    // Private browsing and a full quota both throw here. A forgotten preference
    // is not worth failing a save over.
  }
}

/**
 * The journal's account filter, as of the last time it was changed. Kept so
 * that saving a trade — which remounts the whole view — does not silently drop
 * the trader back to "All accounts" with different numbers in the tiles.
 *
 * `valid` is the set of ids that still exist; anything else falls back to all.
 * The unassigned sentinel is handled by the caller, which knows it.
 */
export function rememberedFilter(validIds, allowed = [], scope) {
  const stored = read(scoped(FILTER_KEY, scope))
  if (allowed.includes(stored)) return stored
  return validIds.includes(stored) ? stored : ''
}

export const rememberFilter = (value, scope) => write(scoped(FILTER_KEY, scope), value)

/** The account the last trade was logged on, used to prefill the trade form. */
export function lastUsedAccount(validIds, scope) {
  const stored = read(scoped(LAST_USED_KEY, scope))
  return validIds.includes(stored) ? stored : ''
}

export const rememberLastUsedAccount = (id, scope) => write(scoped(LAST_USED_KEY, scope), id)

/** Clears one trade's account, leaving the trade itself untouched. */
export async function unassignTrade(tradeId) {
  const { error } = await supabase
    .from('trades')
    .update({ account_id: null, updated_at: Date.now() })
    .eq('id', tradeId)

  if (error) throw error
}
