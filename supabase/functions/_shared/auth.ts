/**
 * Shared request plumbing for the agent functions.
 *
 * `verify_jwt` on its own is not access control. The anon key is itself a valid
 * project JWT and is public by design — it ships inside the browser bundle — so
 * a verify_jwt-only function is callable by anyone who views source. That
 * cannot expose the Anthropic key (it never leaves the server) and cannot be
 * turned into a generation proxy (the prompt is fixed here), but it does let a
 * stranger spend tokens.
 *
 * Resolving the bearer token to an actual user closes that: the anon key
 * carries no user, so `getUser` rejects it.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/**
 * The signed-in user behind this request, or null.
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY are injected into the function runtime;
 * neither needs to be set as a secret.
 */
export async function requireUser(req: Request) {
  const authorization = req.headers.get('Authorization')
  if (!authorization) return null

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    }
  )

  const { data, error } = await client.auth.getUser()
  if (error) return null
  return data.user ?? null
}
