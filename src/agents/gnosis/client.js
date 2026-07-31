import { supabase } from '../../lib/supabase.js'

/** Classifies one note. Same invoke pattern as the other agents. */
export async function classifyNote(path, excerpt) {
  const { data, error } = await supabase.functions.invoke('gnosis-classify', {
    body: { path, excerpt },
  })

  if (error) {
    const detail = await error.context?.json?.().catch(() => null)
    throw new Error(detail?.error ?? error.message)
  }

  return data
}
