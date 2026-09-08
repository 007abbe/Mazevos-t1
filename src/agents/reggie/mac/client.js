import { supabase } from '../../../lib/supabase.js'
import { parseObservations } from '../../../domain/mac/fred.js'
import { REQUIRED_SERIES } from '../../../domain/mac/snapshot.js'

/**
 * The FRED leg of mac.
 *
 * `functions.invoke` derives the URL from the configured Supabase client and
 * attaches the signed-in user's JWT, so there is no function URL to configure
 * and no dev proxy — localhost calls the deployed function directly. Same
 * pattern as `finski/client.js`.
 */

/**
 * Every series mac needs, parsed and keyed by FRED id.
 *
 * A series the function could not fetch is simply absent from the result rather
 * than present and empty. The factors distinguish "missing" from "zero-length"
 * nowhere — both mean no data — but the `failed` map is returned alongside so
 * the UI can say *why* a factor was carried forward instead of leaving the
 * trader to guess at a silent gap.
 *
 * @returns {Promise<{series: Record<string, Array<{date: string, value: number}>>,
 *   failed: Record<string, string>, fetchedAt: string}>}
 */
export async function fetchSeries(ids = REQUIRED_SERIES, asOf = null) {
  const { data, error } = await supabase.functions.invoke('mac-fred', {
    // `asOf` switches the function to ALFRED vintages — each series as it was
    // known on that date, before later revisions. Backtests only; a daily
    // snapshot wants the latest data and passes null.
    body: { series: ids, as_of: asOf },
  })

  if (error) {
    // The function's own JSON error body is more useful than the generic
    // "non-2xx status code" the client surfaces, so prefer it when present.
    const detail = await error.context?.json?.().catch(() => null)
    throw new Error(detail?.error ?? error.message)
  }

  const series = {}
  for (const [id, payload] of Object.entries(data?.series ?? {})) {
    series[id] = parseObservations(payload)
  }

  return { series, failed: data?.failed ?? {}, fetchedAt: data?.fetched_at ?? null }
}
