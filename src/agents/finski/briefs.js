import { supabase } from '../../lib/supabase.js'
import { getUser } from '../../lib/auth.js'

/**
 * The `finski_briefs` table. Same columns FlowJournal writes
 * (trading-journal/index.html:1893), so rows stay readable by both apps.
 */

/** How many past briefs the history panel shows. */
export const BRIEF_HISTORY_LIMIT = 15

/**
 * Recent briefs, newest first.
 *
 * RLS on `finski_briefs` scopes rows to the signed-in user, so there is no
 * explicit user_id filter — matching `loadFinskiBriefs` and the same pattern as
 * `listTrades` in src/journal/trades.js.
 */
export async function listBriefs(client = supabase) {
  const { data, error } = await client
    .from('finski_briefs')
    .select('id,created_at,model_risk,brief')
    .order('created_at', { ascending: false })
    .limit(BRIEF_HISTORY_LIMIT)

  if (error) throw error
  return data ?? []
}

/**
 * Stores one generated brief.
 *
 * `data` keeps the full inputs the brief was written from — VIX, levels,
 * events, yesterday — so a past brief can be read back with the tape it was
 * describing. Same shape FlowJournal wrote.
 */
export async function saveBrief({ risk, brief, data }, client = supabase) {
  const user = await getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await client.from('finski_briefs').insert({
    user_id: user.id,
    model_risk: risk.level,
    triggered: risk.triggered,
    data,
    brief,
  })

  if (error) throw error
}
