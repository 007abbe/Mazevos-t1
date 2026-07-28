import { supabase } from '../lib/supabase.js'
import { getUser } from '../lib/auth.js'
import { fromRow, toRow, stampNow, uid } from './mapping.js'

/**
 * Cloud-first: Supabase is the only store. There is no localStorage mirror and
 * no merge step — unlike FlowJournal, which keeps a local copy and reconciles
 * on `updated_at`. Writes still stamp `updated_at` correctly, because
 * FlowJournal is reading the same rows and does rely on it.
 */

/**
 * Columns for the list view. Deliberately excludes the heavy fields
 * (`image`, `thesis`, `hindsight`) — those are fetched per-trade on demand,
 * not for every row in the list.
 */
const LIST_COLUMNS =
  'id, num, date, type, status, pnl, risk, rr, setup_type, regime, day_type'

/**
 * Reads trades for the signed-in user. RLS on the `trades` table scopes rows,
 * so there is no explicit user_id filter here — same as the legacy dashboard
 * query in legacy/index.html:546.
 *
 * `date` is a text column, so this ordering is lexicographic. That matches
 * chronological order only while dates stay in `YYYY-MM-DDTHH:mm` form.
 */
export async function listTrades({ limit = 500 } = {}) {
  const { data, error } = await supabase
    .from('trades')
    .select(LIST_COLUMNS)
    .order('date', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data ?? []
}

/** One full trade, including the heavy image/thesis/hindsight fields. */
export async function getTrade(id) {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data ? fromRow(data) : null
}

/**
 * Creates or updates one trade. Single-row upsert — FlowJournal re-uploads its
 * entire array on every save (trading-journal/index.html:906), which also means
 * re-sending every base64 screenshot each time.
 *
 * Returns the saved trade as stored.
 */
export async function upsertTrade(trade) {
  const user = await getUser()
  if (!user) throw new Error('Not signed in')

  const row = toRow(stampNow({ ...trade, id: trade.id || uid() }), user.id)

  const { data, error } = await supabase
    .from('trades')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single()

  if (error) throw error
  return fromRow(data)
}

export async function deleteTrade(id) {
  const { error } = await supabase.from('trades').delete().eq('id', id)
  if (error) throw error
}

/**
 * Next display number. FlowJournal derives this from its local array length
 * (`trades.length + 1`), which cloud-first has no equivalent of, so it comes
 * from the current maximum instead. `num` is a display counter, not a key —
 * concurrent creates can collide, and that is acceptable.
 */
export async function nextTradeNum() {
  const { data, error } = await supabase
    .from('trades')
    .select('num')
    .order('num', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return (data?.num ?? 0) + 1
}
