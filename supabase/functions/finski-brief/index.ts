/**
 * Finski pre-market brief — LLM leg.
 *
 * Exists so the Anthropic key stays server-side. FlowJournal called the API
 * straight from the browser with `anthropic-dangerous-direct-browser-access`,
 * which exposes the key to anything running on the page.
 *
 * The prompt is assembled here, not accepted from the client. If this forwarded
 * caller-supplied prompt text it would be an open generation proxy for anyone
 * holding a session; taking structured data against a fixed template bounds it
 * to Finski briefs.
 *
 * Auth: deployed functions verify the caller's JWT by default, so an
 * unauthenticated request never reaches this code. Deploy without
 * `--no-verify-jwt`.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MODEL = 'claude-sonnet-5'

/**
 * Adaptive thinking is on by default for this model and `max_tokens` caps
 * thinking *and* response text together, so the budget is set well above what
 * the four sections need. Effort is `low`: the task is short, scoped, and the
 * hard decision (the risk level) was already made deterministically upstream.
 */
const MAX_TOKENS = 4000
const EFFORT = 'low'

const LEVELS = ['LOW', 'ELEVATED', 'HIGH']

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/** Trims and bounds any caller-supplied string before it reaches the prompt. */
const text = (value: unknown, max = 200): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

type BriefEvent = {
  title: string
  impact: string
  timeLabel: string
  forecast: string
  previous: string
}

function buildPrompt(input: {
  level: string
  triggered: string[]
  vix: { now: number | null; prev: number | null }
  vvix: number | null
  levels: { onHigh: number | null; onLow: number | null; priorClose: number | null }
  events: BriefEvent[]
  yesterday: { date: string; day_type: string | null; regime: string | null } | null
}): string {
  const { level, triggered, vix, vvix, levels, events, yesterday } = input

  const vixChange =
    vix.now != null && vix.prev
      ? `${(((vix.now - vix.prev) / vix.prev) * 100).toFixed(1)}% d/d`
      : 'n/a'

  const manualLevels =
    [
      levels.onHigh != null ? `ON High ${levels.onHigh}` : '',
      levels.onLow != null ? `ON Low ${levels.onLow}` : '',
      levels.priorClose != null ? `Prior close ${levels.priorClose}` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'none provided'

  const eventLines = events.length
    ? events
        .map(
          (e) =>
            `  ${e.timeLabel} — ${e.title} [${e.impact}]` +
            `${e.forecast ? ` fcst ${e.forecast}` : ''}` +
            `${e.previous ? ` prev ${e.previous}` : ''}`
        )
        .join('\n')
    : '  none'

  return `You are Finski, the pre-market briefer for an NQ futures trader running a VWAP-band mean-reversion model (STDV) in the NY AM session (09:30–12:00 ET).

The MODEL-RISK level has ALREADY been decided by hardcoded rules. You never change it, never soften it, never argue with it.

DECIDED BY CODE:
MODEL-RISK: ${level}
Triggered rules: ${triggered.length ? triggered.join(' | ') : 'none'}

DATA:
- VIX: ${vix.now ?? 'n/a'} (prev close ${vix.prev ?? 'n/a'}, ${vixChange})${vvix != null ? ` | VVIX: ${vvix}` : ''}
- Yesterday (own journal): ${
    yesterday
      ? `${yesterday.date} — day_type: ${yesterday.day_type || 'untagged'}, regime: ${yesterday.regime || 'untagged'}`
      : 'no tagged prior day'
  }
- Manual levels: ${manualLevels}
- Today's USD events (High/Medium impact):
${eventLines}

STRICT RULES:
- NEVER predict direction. No bullish/bearish, no bias, no targets. Vol-regime and playability only.
- Only use the data above. No outside knowledge about current markets.
- Every time you write is already labelled with its zone, e.g. "08:30 ET / 14:30 CET". Reproduce those labels exactly as given. Never write a bare time, and never convert between zones yourself.
- If MODEL-RISK is LOW, include the mandatory caveat: trend-day risk cannot be assessed pre-market; confirm regime in first 15 minutes.
- Concise. Plain text. Write everything in English.

OUTPUT FORMAT (exactly these sections, skip MODEL-RISK — it is rendered separately):
REGIME
(2-3 lines: vol state from VIX/VVIX + yesterday's context)

EVENTS
(each relevant event with its labelled time + one line handling instruction, e.g. "sit on hands 08:15–09:00 ET / 14:15–15:00 CET")

LEVELS
(from manual levels if provided; otherwise write "No level data provided — mark ON high/low manually before open")

RISK
(ONE sentence: the single biggest way this day kills the model)`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return json(
      { error: 'ANTHROPIC_API_KEY is not set on this project. Add it under Project Settings → Edge Functions → Secrets.' },
      500
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  const level = text(body.level, 20)
  if (!LEVELS.includes(level)) {
    return json({ error: `level must be one of ${LEVELS.join(', ')}` }, 400)
  }

  const rawVix = (body.vix ?? {}) as Record<string, unknown>
  const rawLevels = (body.levels ?? {}) as Record<string, unknown>
  const rawYesterday = body.yesterday as Record<string, unknown> | null

  const prompt = buildPrompt({
    level,
    triggered: Array.isArray(body.triggered)
      ? body.triggered.slice(0, 20).map((t) => text(t))
      : [],
    vix: { now: num(rawVix.now), prev: num(rawVix.prev) },
    vvix: num(body.vvix),
    levels: {
      onHigh: num(rawLevels.onHigh),
      onLow: num(rawLevels.onLow),
      priorClose: num(rawLevels.priorClose),
    },
    events: Array.isArray(body.events)
      ? body.events.slice(0, 40).map((raw) => {
          const e = (raw ?? {}) as Record<string, unknown>
          return {
            title: text(e.title, 120),
            impact: text(e.impact, 10),
            timeLabel: text(e.timeLabel, 40),
            forecast: text(e.forecast, 20),
            previous: text(e.previous, 20),
          }
        })
      : [],
    yesterday: rawYesterday
      ? {
          date: text(rawYesterday.date, 10),
          day_type: text(rawYesterday.day_type, 40) || null,
          regime: text(rawYesterday.regime, 40) || null,
        }
      : null,
  })

  let response: Response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
  } catch (err) {
    return json({ error: `Could not reach Anthropic: ${(err as Error).message}` }, 502)
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    const message =
      (detail as { error?: { message?: string } })?.error?.message ??
      `Anthropic API error ${response.status}`
    return json({ error: message }, response.status === 429 ? 429 : 502)
  }

  const result = await response.json()

  // Guard before reading content: a refusal returns HTTP 200 with an empty
  // content array, so indexing straight into it would throw.
  if (result.stop_reason === 'refusal') {
    return json({ error: 'Anthropic declined this request.' }, 422)
  }

  const prose = (result.content ?? [])
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('\n')
    .trim()

  if (!prose) {
    return json({ error: `No brief text returned (stop_reason: ${result.stop_reason})` }, 502)
  }

  return json({
    prose,
    truncated: result.stop_reason === 'max_tokens',
    model: result.model,
  })
})
