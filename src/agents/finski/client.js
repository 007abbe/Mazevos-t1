import { supabase } from '../../lib/supabase.js'

/**
 * Calls the `finski-brief` Edge Function.
 *
 * `functions.invoke` derives the URL from the configured Supabase client and
 * attaches the signed-in user's JWT, so there is no function URL to configure
 * and no dev proxy — localhost calls the deployed function directly.
 */
export async function requestBrief(payload) {
  const { data, error } = await supabase.functions.invoke('finski-brief', {
    body: payload,
  })

  if (error) {
    // The function's own JSON error body is more useful than the generic
    // "non-2xx status code" the client surfaces, so prefer it when present.
    const detail = await error.context?.json?.().catch(() => null)
    throw new Error(detail?.error ?? error.message)
  }

  return data
}
