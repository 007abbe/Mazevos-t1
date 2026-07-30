import { supabase } from '../../lib/supabase.js'

/**
 * Calls the `dom-report` Edge Function. Same shape as Finski's client: the URL
 * and the user's JWT both come from the configured Supabase client.
 */
export async function requestReport(payload) {
  const { data, error } = await supabase.functions.invoke('dom-report', {
    body: payload,
  })

  if (error) {
    const detail = await error.context?.json?.().catch(() => null)
    throw new Error(detail?.error ?? error.message)
  }

  return data
}
