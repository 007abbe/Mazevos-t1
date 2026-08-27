/**
 * Row mapping for the `trades` table — the single place column names appear.
 *
 * Ported from FlowJournal's toRow/fromRow (trading-journal/index.html:857 and
 * :875). FlowJournal writes the same rows, so the shapes here are a
 * compatibility contract, not a design choice.
 *
 * Column types, verified against the live database:
 *   id               text     client-generated, not a uuid or serial
 *   user_id          uuid
 *   num              integer  display counter, not unique
 *   date             text     datetime-local string, NOT a date type
 *   pnl/risk/rr      numeric  default 0, not null
 *   stack_ratio      numeric
 *   entry_delay_sec  integer
 *   planned_stop     numeric
 *   actual_exit      numeric
 *   entry_price      numeric  STDV and MM; null on `x` and on older STDV rows
 *   model            text     'STDV' | 'x' | 'MM'; null on pre-MM rows = STDV
 *   mm_setup         text     MM only; setup_type stays STDV's A/B/C
 *   rule_broken      text[]   Postgres array, always an array, never null
 *   band_touched     text[]   was text; see the migration note below
 *   target           text[]   was text; free text as well as the suggestions
 *   gamma_regime     text
 *   major_regime     boolean  null means unanswered, not false
 *   account_id       uuid     FK to accounts(id); null = unassigned
 *   kind             text     'trade' | 'veto'; null on pre-veto rows = trade
 *   veto_outcome     text     veto rows only
 *   conviction       smallint 1-10; null means unanswered
 *   mech_trigger     text     'yes' | 'no' | 'partial'
 *   discretionary_act text[]  Postgres array, like rule_broken
 *   mech_counterfactual_r    numeric
 *   mech_entry/stop/target/exit  numeric  prices, not R
 *   updated_at       bigint   epoch MILLISECONDS — see assertEpochMs below
 *   everything else  text / boolean
 *
 * `band_touched` and `target` were single-value text columns, matching
 * FlowJournal, until they were widened to text[] so a trade could carry more
 * than one. FlowJournal reads and writes both as scalars
 * (trading-journal/index.html:880,886), so it can no longer write this table —
 * it is reference-only from that migration on.
 */

/**
 * Trade ids are generated client-side — the column is text with no database
 * default, so a row written without an id fails.
 *
 * FlowJournal uses `Date.now().toString(36) + Math.random().toString(36).slice(2,6)`
 * (trading-journal/index.html:845). That is only 4 random base36 chars, which
 * collide measurably once several ids are minted inside the same millisecond
 * (~4 collisions per 10k in a tight loop). Manual journalling never hits that,
 * but `id` is the upsert conflict key, so a collision silently overwrites an
 * existing trade — and a bulk import would hit it.
 *
 * Same shape (base36 timestamp prefix, so ids sort by creation at millisecond
 * granularity), wider random suffix from a CSPRNG. FlowJournal treats ids as
 * opaque strings — it only ever compares them — so the format stays compatible,
 * and ids it already wrote remain valid.
 */
export function uid() {
  const r = crypto.getRandomValues(new Uint32Array(2))
  return (
    Date.now().toString(36) +
    r[0].toString(36).padStart(7, '0') +
    r[1].toString(36).padStart(7, '0')
  )
}

/**
 * `date` is a text column, and the trade list orders by it lexicographically.
 * That matches chronological order only while every value keeps the exact
 * `YYYY-MM-DDTHH:mm` shape FlowJournal writes — which is also what an
 * `<input type="datetime-local">` produces and accepts.
 */
export function toDatetimeLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

export function isValidTradeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
}

/**
 * Returns a copy stamped with the current time. Every write must go through
 * this: a trade read via fromRow carries the *stored* updatedAt, and writing
 * that value back unchanged leaves the row looking untouched to FlowJournal's
 * merge, which would then overwrite the edit with its own stale local copy.
 */
export function stampNow(trade) {
  return { ...trade, updatedAt: Date.now() }
}

/**
 * `updated_at` is the last-write-wins merge key shared with FlowJournal, which
 * reads it as `Number(r.updated_at) || 0`. A Postgres timestamp string would
 * parse to NaN there, collapse to 0, and make FlowJournal treat every cloud row
 * as stale — silently overwriting production trades on its next sync.
 *
 * So: integer milliseconds, always. Never a Date, never an ISO string.
 */
function assertEpochMs(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      `updated_at must be epoch milliseconds (integer), got ${JSON.stringify(value)}. ` +
        'Writing a timestamp here corrupts FlowJournal’s merge.'
    )
  }
  return value
}

/** App trade object -> DB row. */
export function toRow(t, userId) {
  if (!userId) throw new Error('toRow requires the signed-in user id')
  return {
    id: t.id,
    user_id: userId,
    num: t.num ?? null,
    date: t.date ?? null,
    type: t.type ?? null,
    status: t.status ?? null,
    pnl: t.pnl ?? 0,
    risk: t.risk ?? 0,
    rr: t.rr ?? 0,
    thesis: t.thesis ?? null,
    hindsight: t.hindsight ?? null,
    image: t.image ?? null,
    // Null means a row written before the model switch existed; the form reads
    // that as STDV rather than rewriting history.
    model: t.model ?? null,
    setup_type: t.setup_type ?? null,
    mm_setup: t.mm_setup ?? null,
    band_touched: Array.isArray(t.band_touched) ? t.band_touched : [],
    away_stack: t.away_stack ?? null,
    stack_ratio: t.stack_ratio ?? null,
    entry_delay_sec: t.entry_delay_sec ?? null,
    planned_stop: t.planned_stop ?? null,
    entry_price: t.entry_price ?? null,
    actual_exit: t.actual_exit ?? null,
    target: Array.isArray(t.target) ? t.target : [],
    be_moved: t.be_moved ?? null,
    be_reason: t.be_reason ?? null,
    regime: t.regime ?? null,
    gamma_regime: t.gamma_regime ?? null,
    // Nullable on purpose: null is "not answered", distinct from a "no".
    major_regime: t.major_regime ?? null,
    day_type: t.day_type ?? null,
    news_window: t.news_window ?? null,
    rule_broken: Array.isArray(t.rule_broken) ? t.rule_broken : [],
    // Null is a real value here, not a missing one: it means the trade is not
    // assigned to any account, which is what every trade logged before accounts
    // existed is. Empty string would violate the uuid column.
    account_id: t.account_id || null,
    // Null is written as null rather than as 'trade': every row logged before
    // vetoes existed has null here, and stamping 'trade' on new rows only would
    // make the column look half-migrated. Readers resolve null themselves.
    kind: t.kind ?? null,
    // Only meaningful on a veto — the form nulls it on a real trade, the same
    // way FlowJournal nulls be_reason when BE wasn't moved.
    veto_outcome: t.veto_outcome ?? null,
    conviction: t.conviction ?? null,
    mech_trigger: t.mech_trigger ?? null,
    discretionary_act: Array.isArray(t.discretionary_act) ? t.discretionary_act : [],
    mech_counterfactual_r: t.mech_counterfactual_r ?? null,
    mech_entry: t.mech_entry ?? null,
    mech_stop: t.mech_stop ?? null,
    mech_target: t.mech_target ?? null,
    mech_exit: t.mech_exit ?? null,
    updated_at: assertEpochMs(t.updatedAt ?? Date.now()),
  }
}

/** DB row -> app trade object. */
export function fromRow(r) {
  return {
    id: r.id,
    num: r.num,
    date: r.date,
    type: r.type,
    status: r.status,
    pnl: Number(r.pnl) || 0,
    risk: Number(r.risk) || 0,
    rr: Number(r.rr) || 0,
    thesis: r.thesis || '',
    hindsight: r.hindsight || '',
    image: r.image || null,
    model: r.model || null,
    setup_type: r.setup_type || null,
    mm_setup: r.mm_setup || null,
    band_touched: Array.isArray(r.band_touched) ? r.band_touched : [],
    away_stack: r.away_stack == null ? false : !!r.away_stack,
    stack_ratio: r.stack_ratio == null ? null : Number(r.stack_ratio),
    entry_delay_sec: r.entry_delay_sec == null ? null : Number(r.entry_delay_sec),
    planned_stop: r.planned_stop == null ? null : Number(r.planned_stop),
    entry_price: r.entry_price == null ? null : Number(r.entry_price),
    actual_exit: r.actual_exit == null ? null : Number(r.actual_exit),
    target: Array.isArray(r.target) ? r.target : [],
    be_moved: r.be_moved == null ? false : !!r.be_moved,
    be_reason: r.be_reason || null,
    regime: r.regime || null,
    gamma_regime: r.gamma_regime || null,
    major_regime: r.major_regime == null ? null : !!r.major_regime,
    day_type: r.day_type || null,
    news_window: r.news_window == null ? false : !!r.news_window,
    rule_broken: Array.isArray(r.rule_broken) ? r.rule_broken : [],
    account_id: r.account_id || null,
    kind: r.kind || null,
    veto_outcome: r.veto_outcome || null,
    conviction: r.conviction == null ? null : Number(r.conviction),
    mech_trigger: r.mech_trigger || null,
    discretionary_act: Array.isArray(r.discretionary_act) ? r.discretionary_act : [],
    // Numerics come back from Postgres as strings, and the discretion delta does
    // arithmetic on this one — an unmapped '1.8' would concatenate, not add.
    mech_counterfactual_r:
      r.mech_counterfactual_r == null ? null : Number(r.mech_counterfactual_r),
    mech_entry: r.mech_entry == null ? null : Number(r.mech_entry),
    mech_stop: r.mech_stop == null ? null : Number(r.mech_stop),
    mech_target: r.mech_target == null ? null : Number(r.mech_target),
    mech_exit: r.mech_exit == null ? null : Number(r.mech_exit),
    updatedAt: Number(r.updated_at) || 0,
  }
}
