/**
 * Gnosis note classification.
 *
 * Assigns a source-quality tier to one vault note. The answer becomes a
 * `tier:` line in the trader's own file, so the failure mode that matters is a
 * confident wrong answer — hence the rubric defaults to 3 when unsure, and the
 * response is schema-constrained rather than parsed out of prose.
 *
 * Same guard as the other agent functions: a real signed-in user, key
 * server-side, prompt assembled here.
 */

import { CORS, json, requireUser } from '../_shared/auth.ts'

const MODEL = 'claude-sonnet-5'

/** One small JSON object per note, over many notes — depth is not the job. */
const MAX_TOKENS = 1000
const EFFORT = 'low'

/** How much of a note the tier decision is made from. */
const EXCERPT_CHARS = 2500

const TIER_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'integer', enum: [1, 2, 3] },
    topic: { type: 'string' },
    source_guess: { type: 'string' },
  },
  required: ['tier', 'topic', 'source_guess'],
  additionalProperties: false,
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

const prompt = (path: string, excerpt: string) =>
  `Classify this trading-knowledge note for a personal knowledge base.

Tier rubric:
1 = primary source (exchange/CBOE docs, academic papers, regulatory filings, the trader's own verified data)
2 = known practitioner with a track record, structured educational material
3 = forum/Discord notes, second-hand summaries, unverified claims

Default to 3 when unsure. This tier is written into the trader's own file and
is used later to weight how much an answer can lean on the note, so a wrong
1 is far more costly than a cautious 3.

topic: a short kebab-case subject, e.g. "vix-term-structure".
source_guess: a brief guess at where the note came from, or "unknown".

File path: ${path}

Note content:
${excerpt}`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const user = await requireUser(req)
  if (!user) return json({ error: 'Sign in required.' }, 401)

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

  const path = text(body.path, 400)
  const excerpt = text(body.excerpt, EXCERPT_CHARS)
  if (!path) return json({ error: 'path is required' }, 400)
  if (!excerpt.trim()) return json({ error: 'excerpt is required' }, 400)

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
        output_config: {
          effort: EFFORT,
          // Schema-constrained, so a malformed reply is impossible rather than
          // silently collapsing to tier 3 the way fence-stripping did.
          format: { type: 'json_schema', schema: TIER_SCHEMA },
        },
        messages: [{ role: 'user', content: prompt(path, excerpt) }],
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
  if (result.stop_reason === 'refusal') {
    return json({ error: 'Anthropic declined to classify this note.' }, 422)
  }

  const raw = (result.content ?? [])
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('')
    .trim()

  let parsed: { tier?: unknown; topic?: unknown; source_guess?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json({ error: `Classifier returned unparseable output (stop_reason: ${result.stop_reason})` }, 502)
  }

  if (![1, 2, 3].includes(parsed.tier as number)) {
    return json({ error: `Classifier returned an invalid tier: ${String(parsed.tier)}` }, 502)
  }

  return json({
    tier: parsed.tier as number,
    topic: text(parsed.topic, 60) || 'untagged',
    source: text(parsed.source_guess, 120) || 'unknown',
    model: result.model,
  })
})
