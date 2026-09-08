/**
 * FRED proxy for mac.
 *
 * Two reasons this exists and one reason it is this thin.
 *
 * Exists because the FRED API key cannot live in the browser bundle — it ships
 * to anyone who views source — and because FRED sends no CORS headers, so a
 * direct fetch from the page is blocked regardless.
 *
 * Thin because every factor rule, threshold and hysteresis counter belongs in
 * `src/domain/mac/`, where `npm test` can reach it. A Deno copy of that logic
 * would be a second implementation to keep in step with the first, and the one
 * that produced the number you traded off would be the untested one. So this
 * function fetches, shapes, and returns; it decides nothing.
 *
 * The series allowlist is the security boundary. Without it this is an open
 * proxy to an arbitrary upstream host, reachable by anyone holding a session.
 *
 * Auth: `verify_jwt` is necessary but not sufficient — the anon key is itself a
 * valid project JWT and is public by design — so every request is resolved to a
 * real signed-in user. Deploy without `--no-verify-jwt`.
 */

import { CORS, json, requireUser } from '../_shared/auth.ts'

const FRED = 'https://api.stlouisfed.org/fred/series/observations'

/**
 * The only series this function will fetch, and how much history each needs.
 *
 * The windows are sized by what the transforms actually read, plus slack. F7's
 * z-score is the expensive one: it scores today's 20-day realised vol against a
 * trailing year of the same statistic, which needs a year of closes plus the
 * twenty that the first of those readings is built from.
 */
const ALLOWED: Record<string, number> = {
  GDPNOW: 400,
  ICSA: 400,
  CPILFESL: 1200,
  PCEPILFE: 1200,
  DFEDTARU: 400,
  DGS2: 400,
  DGS10: 400,
  DFII10: 400,
  WALCL: 400,
  WTREGEN: 400,
  RRPONTSYD: 400,
  BAMLH0A0HYM2: 400,
  BAMLC0A0CM: 400,
  DTWEXBGS: 400,
  DEXJPUS: 400,
  VIXCLS: 500,
  VXVCLS: 500,
  NASDAQ100: 500,
}

/** How many series one request may ask for. */
const MAX_SERIES = 20

/** `YYYY-MM-DD` `days` before today, as FRED's `observation_start`. */
const startDate = (days: number): string =>
  new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

/** `YYYY-MM-DD`, and nothing else, before it reaches an upstream query string. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

async function fetchSeries(id: string, key: string, asOf: string | null) {
  const url = new URL(FRED)
  url.searchParams.set('series_id', id)
  url.searchParams.set('api_key', key)
  url.searchParams.set('file_type', 'json')
  url.searchParams.set('observation_start', startDate(ALLOWED[id]))

  // ALFRED. Setting both realtime bounds to one date returns each series as it
  // was *known* on that date, before later revisions — which is the difference
  // between a backtest and a story. A monthly print released on the 12th is
  // invisible on the 11th, and GDP revised twice still reads at its first
  // estimate. Only backtests pass this; the daily snapshot wants latest data.
  if (asOf) {
    url.searchParams.set('realtime_start', asOf)
    url.searchParams.set('realtime_end', asOf)
  }

  const response = await fetch(url)

  if (!response.ok) {
    // FRED's own message names the series and the problem; the status alone
    // would leave the client guessing which of eighteen requests failed.
    const detail = await response.text().catch(() => '')
    throw new Error(`${id}: FRED ${response.status} ${detail.slice(0, 200)}`)
  }

  return await response.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const user = await requireUser(req)
  if (!user) return json({ error: 'Sign in required' }, 401)

  const key = Deno.env.get('FRED_API_KEY')
  if (!key) return json({ error: 'FRED_API_KEY is not set on this project' }, 500)

  let body: { series?: unknown; as_of?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Expected a JSON body' }, 400)
  }

  const requested = Array.isArray(body.series) ? body.series : []
  const ids = requested.filter((id): id is string => typeof id === 'string' && id in ALLOWED)

  if (ids.length === 0) {
    return json({ error: 'No known series requested' }, 400)
  }
  if (ids.length > MAX_SERIES) {
    return json({ error: `At most ${MAX_SERIES} series per request` }, 400)
  }

  // Rejected rather than ignored: a backtest that silently fell back to latest
  // data would produce confident, revised-hindsight results and look fine.
  const asOf = body.as_of == null ? null : String(body.as_of)
  if (asOf !== null && !ISO_DATE.test(asOf)) {
    return json({ error: 'as_of must be YYYY-MM-DD' }, 400)
  }

  // One slow or broken series must not cost the other seventeen: mac can build
  // a snapshot from a partial fetch and mark the gap in `data_health`, which is
  // strictly better than the whole pre-market read failing on a FRED hiccup.
  const results = await Promise.allSettled(ids.map((id) => fetchSeries(id, key, asOf)))

  const series: Record<string, unknown> = {}
  const failed: Record<string, string> = {}

  results.forEach((result, index) => {
    const id = ids[index]
    if (result.status === 'fulfilled') series[id] = result.value
    else failed[id] = String(result.reason?.message ?? result.reason).slice(0, 300)
  })

  return json({ series, failed, as_of: asOf, fetched_at: new Date().toISOString() })
})
