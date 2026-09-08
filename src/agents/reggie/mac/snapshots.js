import { supabase } from '../../../lib/supabase.js'
import { getUser } from '../../../lib/auth.js'

/**
 * The `macro_snapshots` table.
 *
 * RLS scopes rows to the signed-in user, so there is no explicit user_id filter
 * on reads — same pattern as `finski/briefs.js` and `journal/trades.js`.
 */

/** How many past sessions the history strip and sparkline read. */
export const SNAPSHOT_HISTORY_LIMIT = 30

/**
 * The most recent snapshot strictly before `date`.
 *
 * "Before", not "yesterday": a weekend, a holiday, or a day mac simply was not
 * run must not reset every hysteresis counter to zero. The last snapshot that
 * exists is the state to continue from, whenever it was written.
 *
 * @param {string} date `YYYY-MM-DD`
 */
export async function priorSnapshot(date, client = supabase) {
  const { data, error } = await client
    .from('macro_snapshots')
    .select('date,snapshot')
    .lt('date', date)
    .order('date', { ascending: false })
    .limit(1)

  if (error) throw error
  return data?.[0]?.snapshot ?? null
}

/** Today's snapshot if it has already been computed, else null. */
export async function snapshotFor(date, client = supabase) {
  const { data, error } = await client
    .from('macro_snapshots')
    .select('snapshot')
    .eq('date', date)
    .maybeSingle()

  if (error) throw error
  return data?.snapshot ?? null
}

/** Recent snapshots, newest first. */
export async function listSnapshots(limit = SNAPSHOT_HISTORY_LIMIT, client = supabase) {
  const { data, error } = await client
    .from('macro_snapshots')
    .select('date,computed_at,snapshot')
    .order('date', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data ?? []
}

/**
 * Writes the snapshot for its date, replacing any existing one.
 *
 * Upsert rather than insert because recomputing a day is normal — FRED revises,
 * the ISM gets typed in at 10:00, the pre-market read gets run twice. Two rows
 * for one date would make `priorSnapshot` ambiguous, which is the one thing the
 * carry-forward logic cannot tolerate.
 */
export async function saveSnapshot(snapshot, client = supabase) {
  const user = await getUser()
  if (!user) throw new Error('Not signed in')

  const { error } = await client.from('macro_snapshots').upsert(
    {
      user_id: user.id,
      date: snapshot.date,
      snapshot,
      computed_at: snapshot.computed_at,
    },
    { onConflict: 'user_id,date' }
  )

  if (error) throw error
}
