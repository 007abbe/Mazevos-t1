import { supabase } from '../../lib/supabase.js'
import { getUser } from '../../lib/auth.js'

/**
 * The `dom_reports` table. Same columns FlowJournal writes
 * (trading-journal/index.html:1289), so rows stay readable by both apps — and
 * by Gnosis, which exports these rows into the Obsidian vault.
 */

export const REPORT_HISTORY_LIMIT = 15

/**
 * Recent reports, newest first. RLS scopes rows to the signed-in user, so there
 * is no explicit user_id filter — same pattern as `listTrades` and `listBriefs`.
 */
export async function listReports(client = supabase) {
  const { data, error } = await client
    .from('dom_reports')
    .select('id,created_at,scope,report')
    .order('created_at', { ascending: false })
    .limit(REPORT_HISTORY_LIMIT)

  if (error) throw error
  return data ?? []
}

/**
 * Stores one report with the statistics it was written from, so a past report
 * can be audited against its own numbers rather than re-derived.
 */
export async function saveReport({ scope, tradeIds, stats, report }, client = supabase) {
  const user = await getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await client.from('dom_reports').insert({
    user_id: user.id,
    scope,
    trade_ids: tradeIds,
    stats,
    report,
  })

  if (error) throw error
}
