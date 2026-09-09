/**
 * Index quotes: last price, and the close of the session before it.
 *
 * Finski needs VIX now and VIX previous close on every brief, and until now both
 * were typed in by hand. They are the same chore ISM used to be, with the same
 * failure mode — a number entered from memory on a busy morning is a number
 * nobody checks.
 *
 * The awkward part is "previous close", and it is worth stating because the
 * obvious field is wrong. Yahoo's payload carries `chartPreviousClose`, which is
 * the close *before the requested range* — ask for five days and it hands you a
 * price from six sessions ago. Used as "yesterday" it would quietly feed the
 * model-risk rules a stale VIX with a plausible-looking value, and the gap only
 * shows up on days when it matters.
 *
 * So the previous close is taken from the session series instead: the last
 * session strictly before today in New York. That also handles the case the
 * request is really about — during the session the newest row *is* today, and
 * it is a partial bar, not a close.
 *
 * Pure. The payload comes in as an object.
 */

import { etDate } from './et-session.js'

/**
 * Volatility indices are quoted to two decimals, and nothing else is real.
 *
 * Yahoo's daily closes come back as float32 widened to double, so 15.72 arrives
 * as 15.720000267028809. Put straight into a number field that reads as a broken
 * feed, and it is the first thing you notice about an auto-filled box.
 */
const round2 = (value) =>
  value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100

/**
 * Cboe's own quote for one index.
 *
 * The preferred source, because Cboe *computes* VIX — everywhere else is a
 * redistributor, TradingView included. It also states `prev_day_close` outright
 * rather than leaving the previous session to be derived from a bar series,
 * which removes the partial-bar hazard entirely.
 *
 * Roughly fifteen minutes delayed. That is immaterial to a pre-market brief and
 * worth saying out loud for one used intraday.
 *
 * @param {object} payload the `delayed_quotes` response
 * @param {number} [now] epoch ms
 */
export function readCboeQuote(payload, now = Date.now()) {
  const data = payload?.data
  if (!data) return { now: null, prev: null, prev_date: null, as_of: null }

  const stamp = Date.parse(`${String(payload.timestamp ?? '').replace(' ', 'T')}Z`)

  return {
    now: round2(data.current_price),
    prev: round2(data.prev_day_close),
    // Cboe names the value but not its session. Left null rather than guessed
    // at: the last trading day before today is a calendar question with holidays
    // in it, and a wrong date beside a right number is worse than no date.
    prev_date: null,
    as_of: Number.isFinite(stamp) ? stamp : now,
  }
}

/**
 * Reads one Yahoo chart payload.
 *
 * `now` is the last traded price, which before the open is simply the previous
 * close repeated — that is Yahoo's behaviour, not an assumption made here, and
 * it is the right value either way: nothing has traded since.
 *
 * Returns nulls rather than throwing on a shape it does not recognise. A quote
 * that fails must leave the field empty for the trader to fill, never guess.
 *
 * @param {object} payload the `chart` response for one symbol
 * @param {number} [now] epoch ms, for deciding which session counts as today
 * @returns {{now: number|null, prev: number|null, prev_date: string|null,
 *   as_of: number|null}}
 */
export function readQuote(payload, now = Date.now()) {
  const empty = { now: null, prev: null, prev_date: null, as_of: null }

  const result = payload?.chart?.result?.[0]
  if (!result) return empty

  const meta = result.meta ?? {}
  const stamps = result.timestamp ?? []
  const closes = result.indicators?.quote?.[0]?.close ?? []

  const today = etDate(now)

  // The last session that is genuinely finished. Today's row, when it exists, is
  // a partial bar during the session and must not be read as a close.
  let prev = null
  let prevDate = null

  for (let i = 0; i < stamps.length; i += 1) {
    const close = closes[i]
    if (close == null || !Number.isFinite(close)) continue

    const date = etDate(stamps[i] * 1000)
    if (date >= today) continue

    prev = close
    prevDate = date
  }

  const last = meta.regularMarketPrice
  const asOf = meta.regularMarketTime

  return {
    now: round2(Number.isFinite(last) ? last : null),
    prev: round2(prev),
    prev_date: prevDate,
    as_of: Number.isFinite(asOf) ? asOf * 1000 : null,
  }
}

/**
 * Reads whichever source answered.
 *
 * The Edge Function tags its response rather than leaving the shape to be
 * sniffed, so a change upstream shows up as an unknown tag instead of as a
 * payload that half-parses.
 */
export function readQuotePayload(entry, now = Date.now()) {
  if (entry?.source === 'cboe') return readCboeQuote(entry.payload, now)
  if (entry?.source === 'yahoo') return readQuote(entry.payload, now)
  return { now: null, prev: null, prev_date: null, as_of: null }
}

/** 09:30 New York, in minutes from midnight. */
const OPEN_MINUTES = 9 * 60 + 30

/**
 * Whether the cash session has opened, in New York terms.
 *
 * The VIX index itself is only disseminated during the cash session, so before
 * the open there is no "current" reading to have — the last price is yesterday's
 * close wearing a fresh timestamp. Saying so is the difference between a brief
 * that reports a live number and one that reports a stale number as live.
 *
 * @param {number} now epoch ms
 */
export function sessionOpen(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(now))

  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = get('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return false

  const minutes = Number(get('hour')) * 60 + Number(get('minute'))
  return minutes >= OPEN_MINUTES
}

/**
 * What to put in front of the trader, and where it came from.
 *
 * Before the open `now` is reported as the previous close and labelled as such,
 * because that is what it is. Pretending a pre-market read is live would put a
 * number in the brief that the model-risk rules treat as today's vol.
 *
 * @param {{now: number|null, prev: number|null, prev_date: string|null}} quote
 * @param {number} now epoch ms
 */
export function describeQuote(quote, now = Date.now()) {
  const open = sessionOpen(now)

  if (quote?.now == null && quote?.prev == null) {
    return { value: null, prev: null, live: false, source: 'unavailable' }
  }

  // Outside the session the index is not being disseminated, so the last price
  // is the previous close whatever the timestamp says.
  if (!open) {
    return {
      value: quote.prev ?? quote.now,
      prev: quote.prev,
      live: false,
      source: 'previous close — session has not opened',
    }
  }

  return {
    value: quote.now ?? quote.prev,
    prev: quote.prev,
    live: quote.now != null,
    source: quote.now != null ? 'live' : 'previous close — no live price',
  }
}
