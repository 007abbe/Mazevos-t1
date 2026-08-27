import { supabase } from '../lib/supabase.js'
import { getUser } from '../lib/auth.js'
import { fromRow, toRow, stampNow, uid } from './mapping.js'
import { listAccounts } from './accounts.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { isRealTrade } from '../domain/veto-vocab.js'

/**
 * Cloud-first: Supabase is the only store. There is no localStorage mirror and
 * no merge step — unlike FlowJournal, which keeps a local copy and reconciles
 * on `updated_at`. Writes still stamp `updated_at` correctly, because
 * FlowJournal is reading the same rows and does rely on it.
 */

/**
 * Columns for the list view. Excludes `image` and `hindsight` — those are
 * fetched per-trade on demand, not for every row in the list.
 *
 * `thesis` is the one heavy field that has to travel with the list: the
 * journal's search box filters on it client-side, over the trades already
 * loaded. Fetching it per-row on keystroke would be a query per character.
 */
const LIST_COLUMNS = `
  id, num, date, type, status, pnl, risk, rr, thesis, model, setup_type, mm_setup,
  regime, day_type, account_id, kind, veto_outcome, conviction, mech_trigger,
  mech_counterfactual_r
`

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

/**
 * Every column DOM's analysis reads — the model tags, the sequencing fields,
 * and the trader's own notes — but *not* `image`, which holds base64
 * screenshots and would dominate the response for a large selection.
 */
const ANALYSIS_COLUMNS = `
  id, num, date, type, status, pnl, risk, rr, thesis, hindsight,
  model, setup_type, mm_setup, band_touched, away_stack, stack_ratio,
  entry_delay_sec, planned_stop, entry_price, actual_exit, target, be_moved,
  be_reason, regime, day_type, news_window, rule_broken, account_id, kind,
  conviction, mech_trigger, discretionary_act, mech_counterfactual_r, updated_at
`

/**
 * Trades for DOM, mapped through `fromRow`.
 *
 * The mapping is not optional: Postgres returns numerics as strings, and the
 * statistics module does arithmetic on `pnl` and `risk`. Unmapped rows would
 * produce quietly wrong numbers rather than an error.
 */
export async function listTradesForAnalysis({ limit = 500 } = {}) {
  // Accounts come along because DOM analyses *executed* trades: a backtest
  // account's fills were never real, and telling the model that a simulated run
  // is your live edge is worse than telling it nothing. Handful of rows, and it
  // rides alongside the trade query rather than after it.
  const [{ data, error }, accounts] = await Promise.all([
    supabase.from('trades').select(ANALYSIS_COLUMNS).order('date', { ascending: false }).limit(limit),
    listAccounts().catch(() => []),
  ])

  if (error) throw error

  const backtest = backtestAccountIds(accounts)
  return (data ?? [])
    .map(fromRow)
    .filter((t) => isRealTrade(t) && !backtest.has(t.account_id))
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
