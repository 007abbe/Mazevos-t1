/**
 * What kind of row a journal entry is, and the vocabulary of the discretion
 * audit that sits on top of it.
 *
 * Two separate ideas, one module, because the form asks them in one breath and
 * they share the same enforcement: a veto has no P&L, so it must be excluded
 * from every aggregate that has a dollar sign or a percent in it, and the
 * discretion fields are the only numbers a veto row *can* contribute.
 *
 * Unlike trade-vocab.js these are not a FlowJournal compatibility contract —
 * FlowJournal has no concept of a veto. They are still stored strings, so
 * changing a value here means migrating existing rows.
 */

/**
 * 'trade' — you took it. 'veto' — you did not, and this row is the record of
 * why.
 */
export const KINDS = ['trade', 'veto']

export const DEFAULT_KIND = 'trade'

/**
 * Null is a real answer here: every row written before `kind` existed is a
 * trade, because a veto was not something the form could log. Reading null as
 * 'trade' is what lets the migration stay additive.
 */
export const tradeKind = (t) => (t?.kind === 'veto' ? 'veto' : 'trade')

export const isVeto = (t) => tradeKind(t) === 'veto'

/** The complement, named so filters read as intent rather than as a negation. */
export const isRealTrade = (t) => !isVeto(t)

/**
 * What the vetoed idea would have done. Deliberately coarse: a veto has no
 * fill, so any finer answer would be a number you invented after the fact.
 * 'unclear' is not a cop-out — it is the honest answer whenever the level was
 * touched but the trade would have needed management to survive.
 */
export const VETO_OUTCOMES = ['win', 'loss', 'breakeven', 'unclear']

/** Display labels; the stored value stays lowercase. */
export const VETO_OUTCOME_LABELS = {
  win: 'Would win',
  loss: 'Would lose',
  breakeven: 'Would scratch',
  unclear: 'Unclear',
}

/**
 * Would a strict mechanical SPM/MM have fired here?
 *
 * 'partial' is its own answer rather than a rounding of yes or no: the signal
 * half-formed, and folding it either way would corrupt the discretion delta,
 * which is computed over 'yes' rows only.
 */
export const MECH_TRIGGERS = ['yes', 'no', 'partial']

/**
 * What you did that the mechanical version would not have. Stored as a
 * Postgres text[] — a trade can carry several, since shifting the entry and
 * cutting early are two separate departures from the plan.
 *
 * 'none' is stored explicitly rather than left as an empty array. An empty
 * array means "not answered"; 'none' means "asked, and I followed the plan" —
 * the difference matters when reading back whether an old trade was audited.
 */
export const DISCRETIONARY_ACTS = [
  { value: 'none', label: 'None' },
  { value: 'entry_shifted', label: 'Entry shifted' },
  { value: 'size_adjusted', label: 'Size adjusted' },
  { value: 'managed_early', label: 'Managed early' },
  { value: 'held_past_target', label: 'Held past target' },
  { value: 'overrode_veto', label: 'Overrode veto' },
]

export const DISCRETIONARY_ACT_VALUES = DISCRETIONARY_ACTS.map((a) => a.value)

export const CONVICTION_MIN = 1
export const CONVICTION_MAX = 10

/**
 * Conviction as it should be stored: an integer in range, or null.
 *
 * Clamps rather than rejects. This is one field in a long form and the value is
 * a self-report on a made-up scale — refusing the save over an 11 would cost
 * the trader the whole entry to correct a number that means "very high" either
 * way.
 */
export function normaliseConviction(value) {
  // Checked before Number(), which reads '' and null as 0 — and 0 would then
  // clamp to a 1, turning an unanswered field into the lowest conviction there
  // is. An empty box has to stay empty.
  if (value === null || value === undefined || String(value).trim() === '') return null

  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.min(CONVICTION_MAX, Math.max(CONVICTION_MIN, n))
}
