/**
 * Index quote proxy for Finski.
 *
 * Exists for one reason: Yahoo sends no CORS headers, so the page cannot read a
 * quote directly. There is no API key involved — unlike `mac-fred` this guards
 * nothing secret, it only crosses an origin.
 *
 * Thin for the same reason `mac-fred` is thin. Deciding what "previous close"
 * means, and whether a price counts as live, is real logic with a real failure
 * mode — Yahoo's own `chartPreviousClose` is the close before the *range*, six
 * sessions back on a 5-day request, which reads as yesterday and is not. That
 * decision lives in `src/domain/quote.js`, where `npm test` reaches it. This
 * function fetches and forwards.
 *
 * The symbol allowlist is the security boundary. Without it this is an open
 * proxy to an arbitrary upstream, reachable by anyone holding a session.
 *
 * Auth: `verify_jwt` is necessary but not sufficient — the anon key is itself a
 * valid project JWT and is public by design — so every request resolves to a
 * real signed-in user. Deploy without `--no-verify-jwt`.
 */

import { CORS, json, requireUser } from '../_shared/auth.ts'

const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes'
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart'

/**
 * Cboe's own symbols. Cboe *computes* these indices — every other quote source,
 * TradingView included, is redistributing them — so it is asked first and Yahoo
 * only stands in when it cannot be reached.
 */
const CBOE_SYMBOL: Record<string, string> = { '^VXN': '_VXN', '^VIX': '_VIX', '^VVIX': '_VVIX' }

/**
 * The only symbols this will fetch.
 *
 * All Cboe volatility indices. `^VXN` is the one Finski reads — NQ is the
 * Nasdaq-100 and VXN is its volatility index, where VIX is the S&P's — and
 * `^VIX` stays allowed because it costs nothing and is the obvious next ask.
 * Adding a symbol here is a deliberate act; `^` is not a character that should
 * reach a URL from user input by accident.
 */
const ALLOWED = new Set(['^VXN', '^VIX', '^VVIX'])

/** Enough sessions to always contain a finished one, across a long weekend. */
const RANGE = '10d'

/**
 * Yahoo answers a plain client but not an obviously scripted one, and a UA is
 * the whole difference. Same accommodation the ISM scrape makes, for the same
 * upstream reason.
 */
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  accept: 'application/json',
}

async function fetchCboe(symbol: string) {
  const slug = CBOE_SYMBOL[symbol]
  if (!slug) throw new Error(`${symbol}: no Cboe symbol`)

  const response = await fetch(`${CBOE}/${slug}.json`)
  if (!response.ok) throw new Error(`${symbol}: Cboe ${response.status}`)

  const payload = await response.json()
  // A 200 carrying no quote is a failure that must fall through to Yahoo rather
  // than be forwarded as an empty but well-formed answer.
  if (payload?.data?.current_price == null) throw new Error(`${symbol}: Cboe returned no price`)

  return payload
}

async function fetchYahoo(symbol: string) {
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d`
  const response = await fetch(url, { headers: HEADERS })

  if (!response.ok) throw new Error(`${symbol}: Yahoo ${response.status}`)

  return await response.json()
}

/**
 * Cboe first, Yahoo second, and the answer says which.
 *
 * Tagged rather than left to be sniffed by shape: an upstream change then
 * surfaces as an unrecognised tag instead of as a payload that half-parses into
 * plausible numbers.
 */
async function fetchSymbol(symbol: string) {
  try {
    return { source: 'cboe', payload: await fetchCboe(symbol) }
  } catch (cboeError) {
    try {
      return { source: 'yahoo', payload: await fetchYahoo(symbol) }
    } catch (yahooError) {
      const first = cboeError instanceof Error ? cboeError.message : String(cboeError)
      const second = yahooError instanceof Error ? yahooError.message : String(yahooError)
      throw new Error(`${first}; then ${second}`)
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const user = await requireUser(req)
  if (!user) return json({ error: 'Sign in required' }, 401)

  let body: { symbols?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Expected a JSON body' }, 400)
  }

  const requested = Array.isArray(body.symbols) ? body.symbols : []
  const symbols = requested.filter(
    (s): s is string => typeof s === 'string' && ALLOWED.has(s)
  )

  if (symbols.length === 0) return json({ error: 'No known symbols requested' }, 400)

  const quotes: Record<string, unknown> = {}
  const failed: Record<string, string> = {}

  // One symbol failing must not take the other down: VVIX is optional to the
  // brief and VIX is not, so they are reported separately rather than as one
  // all-or-nothing result.
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        quotes[symbol] = await fetchSymbol(symbol)
      } catch (error) {
        failed[symbol] = error instanceof Error ? error.message : String(error)
      }
    })
  )

  return json({ quotes, failed, fetched_at: new Date().toISOString() })
})
