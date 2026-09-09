import { supabase } from '../../lib/supabase.js'
import { describeQuote, readQuotePayload } from '../../domain/quote.js'

/**
 * The VXN leg of Finski.
 *
 * VXN now and VXN previous close were typed in by hand on every brief. VXN, not
 * VIX: NQ is the Nasdaq-100 and VXN is its own volatility index. They are
 * the last of the numbers that were, and the same argument applies as to ISM: a
 * figure entered from memory before the open is a figure nobody checks, and it
 * feeds the model-risk rules directly.
 *
 * Same shape as `mac/client.js` — `functions.invoke` derives the URL from the
 * configured Supabase client and attaches the signed-in user's JWT, so there is
 * no function URL to configure and localhost calls the deployed function.
 *
 * All the judgement lives in `src/domain/quote.js`: which row counts as the
 * previous close, and whether a price is live or just yesterday's wearing a
 * fresh timestamp.
 */

export const VXN = '^VXN'
export const VVIX = '^VVIX'

/**
 * VXN and VVIX, ready for the brief's fields.
 *
 * Never throws. Finski refuses to run without a VXN, so a failed quote has to
 * leave the field empty and editable rather than block the brief or, worse,
 * fill it with something invented. The caller is told what happened through
 * `failed` so the panel can say why a box is blank.
 *
 * @param {number} [now] epoch ms, for deciding whether the session has opened
 * @returns {Promise<{vxn: object|null, vvix: object|null, failed: string|null}>}
 */
export async function fetchVolQuotes(now = Date.now()) {
  try {
    const { data, error } = await supabase.functions.invoke('market-quote', {
      body: { symbols: [VXN, VVIX] },
    })

    if (error) {
      const detail = await error.context?.json?.().catch(() => null)
      throw new Error(detail?.error ?? error.message)
    }

    const read = (symbol) => {
      const entry = data?.quotes?.[symbol]
      if (!entry) return null

      const quote = readQuotePayload(entry, now)
      return { ...quote, ...describeQuote(quote, now), feed: entry.source }
    }

    return { vxn: read(VXN), vvix: read(VVIX), failed: null }
  } catch (err) {
    return { vxn: null, vvix: null, failed: err.message }
  }
}
