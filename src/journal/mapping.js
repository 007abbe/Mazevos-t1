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
 *   rule_broken      text[]   Postgres array, always an array, never null
 *   updated_at       bigint   epoch MILLISECONDS — see assertEpochMs below
 *   everything else  text / boolean
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
    setup_type: t.setup_type ?? null,
    band_touched: t.band_touched ?? null,
    away_stack: t.away_stack ?? null,
    stack_ratio: t.stack_ratio ?? null,
    entry_delay_sec: t.entry_delay_sec ?? null,
    planned_stop: t.planned_stop ?? null,
    actual_exit: t.actual_exit ?? null,
    target: t.target ?? null,
    be_moved: t.be_moved ?? null,
    be_reason: t.be_reason ?? null,
    regime: t.regime ?? null,
    day_type: t.day_type ?? null,
    news_window: t.news_window ?? null,
    rule_broken: Array.isArray(t.rule_broken) ? t.rule_broken : [],
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
    setup_type: r.setup_type || null,
    band_touched: r.band_touched || null,
    away_stack: r.away_stack == null ? false : !!r.away_stack,
    stack_ratio: r.stack_ratio == null ? null : Number(r.stack_ratio),
    entry_delay_sec: r.entry_delay_sec == null ? null : Number(r.entry_delay_sec),
    planned_stop: r.planned_stop == null ? null : Number(r.planned_stop),
    actual_exit: r.actual_exit == null ? null : Number(r.actual_exit),
    target: r.target || null,
    be_moved: r.be_moved == null ? false : !!r.be_moved,
    be_reason: r.be_reason || null,
    regime: r.regime || null,
    day_type: r.day_type || null,
    news_window: r.news_window == null ? false : !!r.news_window,
    rule_broken: Array.isArray(r.rule_broken) ? r.rule_broken : [],
    updatedAt: Number(r.updated_at) || 0,
  }
}
