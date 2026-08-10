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
 *   STDV — the original model; every trade logged before `model` existed.
 *   x    — no model tags at all, just thesis, hindsight and a screenshot.
 *   MM   — shares regime/gamma/target/BE/rules with STDV, swaps setup A/B/C and
 *          band touched for its own four setups and an entry price.
 */
export const MODELS = ['STDV', 'x', 'MM']

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

export const BANDS = ['+2.6σ', '+2σ', '-2σ', '-2.6σ']

/**
 * Suggested targets. `target` also accepts free text, so this is not
 * exhaustive — the form offers these in a dropdown and takes anything else
 * typed into its custom field.
 */
export const TARGETS = ['VWAP', 'POC', 'HVN', 'Major putwall', 'Major callwall']

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

/** Stored as a Postgres text[]. Values are snake_case; labels are for display. */
export const RULES_BROKEN = [
  { value: 'early_entry', label: 'Early entry' },
  { value: 'chased_entry', label: 'Chased entry' },
  { value: 'no_away_stack', label: 'No away-stack' },
  { value: 'size_over_cap', label: 'Size over cap' },
  { value: 'traded_news', label: 'Traded news' },
  { value: 'be_fear', label: 'BE from fear' },
  { value: 'other', label: 'Other' },
]

export const RULE_BROKEN_VALUES = RULES_BROKEN.map((r) => r.value)
