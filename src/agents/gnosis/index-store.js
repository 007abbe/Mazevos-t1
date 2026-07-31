import { supabase } from '../../lib/supabase.js'

/**
 * The `gnosis_files` / `gnosis_chunks` index.
 *
 * Read-only for now — the write side belongs to sync apply, which is not wired
 * yet. RLS scopes rows to the signed-in user, as elsewhere.
 */

/** Path → content hash, for the scan's diff. */
export async function listIndexedFiles(client = supabase) {
  const { data, error } = await client.from('gnosis_files').select('path,hash')

  if (error) throw error
  return new Map((data ?? []).map((row) => [row.path, row.hash]))
}

/** Every DOM report, oldest first, for the vault export diff. */
export async function listReportsForExport(client = supabase) {
  const { data, error } = await client
    .from('dom_reports')
    .select('id,created_at,scope,report')
    .order('created_at', { ascending: true })

  if (error) throw error
  return data ?? []
}
