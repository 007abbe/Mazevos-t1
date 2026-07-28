import { supabase } from '../lib/supabase.js'

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
