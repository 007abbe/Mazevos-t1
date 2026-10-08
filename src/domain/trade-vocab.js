/**
 * Controlled vocabularies for trade tagging.
 *
 * These are the exact string values FlowJournal writes to the production
 * `trades` table (trading-journal/index.html, the tag pills and selects).
 * Both apps write the same rows, so these values are a compatibility contract —
 * changing one means migrating existing rows.
 *
 * Agent-agnostic and UI-free: forms read their options from here, they do not
 * define them.
 */

export const TYPES = ['Long', 'Short']

export const STATUSES = ['Open', 'TP', 'SL', 'BE', 'TP1+BE']

/**
 * Trading models. Which one a trade belongs to decides which tags the form
 * offers and which columns get written:
 *   STDV  — the original model; every trade logged before `model` existed.
 *   x     — no model tags at all, just thesis, hindsight and a screenshot.
 *   MM    — shares regime/gamma/target/BE/rules with STDV, swaps setup A/B/C and
 *           band touched for its own four setups and an entry price.
 *   SPM-R — reversion model. Shares gamma/major regime, target, BE, news and
 *           rules; brings a grade, an entry trigger, a tier and a reversion
 *           zone. No `regime` and no `day_type` — it does not read either.
 */
export const MODELS = ['STDV', 'x', 'MM', 'SPM-R']

export const DEFAULT_MODEL = 'STDV'

/** STDV's setups. Kept in `setup_type`, which is STDV-only. */
export const SETUP_TYPES = ['A', 'B', 'C']

/** MM's setups. Kept in `mm_setup`, a separate column from `setup_type`. */
export const MM_SETUPS = [
  'Open-Drive',
  'Open-Test-Drive',
  'LVN-Momentum-Breakout',
  'Gamma-wall-Consumption-break',
]

/**
 * SPM-R's grade. Deliberately not `setup_type`: STDV's A/B/C are three
 * different setups, these are one setup's quality score, and a column holding
 * both would make every by-setup statistic mix the two. Kept in `spm_grade`.
 */
export const SPM_GRADES = ['A', 'B', 'C', 'F']

/** SPM-R's entry triggers. Stored as a text[] — a trade can have more than one. */
export const ENTRY_TRIGGERS = ['Absorption', '3x Imbalance', 'Initiation', 'Delta-flip']

/** SPM-R's tier. One per trade, kept in `tier`. */
export const TIERS = ['T1', 'T2', 'T3', 'T4', 'T5']

/**
 * SPM-R's reversion zones. Stored as a text[], like `target`, because a level
 * that is worth reverting from is usually several things at once.
 *
 * Unsigned on purpose — a zone is a location, and whether it is above or below
 * is already in `type`. The sigma entries name which chart the band is drawn
 * on, which is the distinction that decides whether two of them are confluence
 * or the same line counted twice.
 *
 * `other` is a legal value, and selecting it reveals a free-text box whose
 * contents are stored in place of the literal 'other' — the same way `target`
 * takes a hand-typed level. A bare 'other' survives only when the box is left
 * empty, which reads as "a zone I did not name".
 */
export const REV_ZONES = [
  'LVNs',
  'Prev-day LVN',
  'Weekly LVN',
  'Prev-day ledge',
  'Weekly ledge',
  'Major callwall',
  'Major putwall',
  'Callwall',
  'Putwall',
  '2σ RTH',
  '2.6σ RTH',
  '2σ chart',
  '2.6σ chart',
  '2σ weekly',
  '2.6σ weekly',
  'Prev-day VAH',
  'Prev-day VAL',
  'Weekly VAH',
  'Weekly VAL',
  'Prev-day POC',
  'Weekly POC',
  'Extreme',
  'G-flip',
  'other',
]

/** The one REV_ZONES entry that opens a text box. */
export const REV_ZONE_OTHER = 'other'

/**
 * The column each model keeps its setup in. STDV's A/B/C live in `setup_type`,
 * MM's four named setups in `mm_setup`, SPM-R's grade in `spm_grade`.
 *
 * One table and one reader, because the journal list, DOM's picker and DOM's
 * report each had their own copy of the same ternary — so a fourth model meant
 * finding three call sites, and missing one showed a blank setup column rather
 * than failing. A model absent here has no setup of its own (`x`), and a trade
 * with no `model` at all predates the switch and is STDV.
 */
export const SETUP_COLUMNS = {
  STDV: 'setup_type',
  MM: 'mm_setup',
  'SPM-R': 'spm_grade',
}

export function modelSetup(trade) {
  const column = SETUP_COLUMNS[trade?.model || DEFAULT_MODEL]
  return (column ? trade?.[column] : null) ?? null
}

export const BANDS = ['+2.6σ', '+2σ', '-2σ', '-2.6σ']

/**
 * Suggested targets. `target` also accepts free text, so this is not
 * exhaustive — the form offers these in a dropdown and takes anything else
 * typed into its custom field.
 *
 * Shared by every model that logs a target. The single `POC` entry became three
 * named ones when SPM-R arrived, because which POC it was is the whole content
 * of the target. Rows written before that keep the bare `POC` they were saved
 * with: the column is free text so they still read and still display, and there
 * is no way to know after the fact which of the three was meant.
 */
export const TARGETS = [
  'VWAP',
  'Weekly-POC',
  'Prev-day-POC',
  'Intraday-POC',
  'HVN',
  'Single-prints',
  'Major putwall',
  'Major callwall',
  'Callwall',
  'Putwall',
]

export const REGIMES = ['trend', 'balance', 'volatile']

/** Gamma regime. Lowercase values; the form capitalises the labels. */
export const GAMMA_REGIMES = ['positive', 'negative']

/** Only meaningful when `be_moved` is true; FlowJournal nulls it otherwise. */
export const BE_REASONS = ['fear', 'structure']

export const DAY_TYPES = [
  'Trend Day',
  'Double Distribution',
  'Normal Day',
  'Normal Variation',
  'Neutral Day',
  'Neutral Extreme',
  'P-shape',
  'b-shape',
]

/**
 * Rules broken. Stored as a Postgres text[]; values are snake_case, labels are
 * for display.
 *
 * Two labels were rewritten when SPM-R arrived — "No away-stack" became "No
 * entry trigger" and "Size over cap" became "Too much risk" — while their
 * stored values did not move. The rule is the same rule under either name, and
 * renaming the value would have meant rewriting `rule_broken` on every trade
 * that already carried it; the tally in trade-stats.js counts by value, so
 * adding a second spelling would have split one rule across two buckets at the
 * cutover date instead. The labels are what you read, the values are what the
 * history is written in, and only the labels needed to change.
 */
export const RULES_BROKEN = [
  { value: 'early_entry', label: 'Early entry' },
  { value: 'chased_entry', label: 'Chased entry' },
  { value: 'no_away_stack', label: 'No entry trigger' },
  { value: 'size_over_cap', label: 'Too much risk' },
  { value: 'traded_news', label: 'Traded news' },
  { value: 'be_fear', label: 'BE from fear' },
  { value: 'other', label: 'Other' },
]

export const RULE_BROKEN_VALUES = RULES_BROKEN.map((r) => r.value)
