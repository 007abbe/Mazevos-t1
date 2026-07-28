import { supabase } from './supabase.js'

// Same key FlowJournal used, so a remembered email carries over on the shared origin.
const EMAIL_KEY = 'flowjournal_email'

export function getRememberedEmail() {
  return localStorage.getItem(EMAIL_KEY) || ''
}

export async function getUser() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data.session?.user ?? null
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  localStorage.setItem(EMAIL_KEY, email)
  return data.user
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

/**
 * Calls `handler(user | null)` on every auth change, including an INITIAL_SESSION
 * event fired once the stored session is resolved. Returns an unsubscribe function.
 */
export function onAuthChange(handler) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    handler(session?.user ?? null)
  })
  return () => data.subscription.unsubscribe()
}
