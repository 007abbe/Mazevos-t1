import {
  TYPES, STATUSES, MODELS, DEFAULT_MODEL, SETUP_TYPES, MM_SETUPS, BANDS, TARGETS,
  REGIMES, GAMMA_REGIMES, BE_REASONS, DAY_TYPES, RULES_BROKEN,
  SPM_GRADES, ENTRY_TRIGGERS, TIERS, REV_ZONES, REV_ZONE_OTHER,
} from '../domain/trade-vocab.js'
import {
  KINDS, DEFAULT_KIND, VETO_OUTCOMES, VETO_OUTCOME_LABELS, MECH_TRIGGERS,
  DISCRETIONARY_ACTS, CONVICTION_MIN, CONVICTION_MAX, normaliseConviction, tradeKind,
} from '../domain/veto-vocab.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { SCOPES } from './filters.js'
import { upsertTrade, deleteTrade, getTrade, nextTradeNum } from './trades.js'
import { listAccounts, lastUsedAccount, rememberLastUsedAccount } from './accounts.js'
import { toDatetimeLocal, isValidTradeDate } from './mapping.js'
import { compressImage, dataUrlBytes, isImageFile, MAX_IMAGES } from './screenshots.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const numOrNull = (value) => {
  const v = parseFloat(value)
  return Number.isNaN(v) ? null : v
}


const pill = (key, value, label = value) =>
  `<button type="button" class="pill" data-key="${esc(key)}" data-val="${esc(value)}">${esc(label)}</button>`

/** `key` names the Set on `state` this pill toggles membership of. */
const multiPill = (key, value, label = value, cls = '') =>
  `<button type="button" class="pill ${cls}" data-multi="${esc(key)}" data-val="${esc(value)}">${esc(label)}</button>`

const options = (values, selected) =>
  values.map((v) => `<option${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('')

/**
 * Display order for pill rows, matching FlowJournal. The vocabularies in
 * src/domain/trade-vocab.js are the storage contract and define the *set* of
 * legal values; the order they happen to be written in there is not meaningful,
 * so the order the user sees lives here. Values missing from `order` fall to
 * the end rather than disappearing.
 */
const inOrder = (values, order, keyOf = (v) => v) => {
  const rank = (v) => {
    const i = order.indexOf(keyOf(v))
    return i < 0 ? order.length : i
  }
  return [...values].sort((a, b) => rank(a) - rank(b))
}

const BAND_ORDER = ['+2σ', '+2.6σ', '-2σ', '-2.6σ']
const BE_REASON_ORDER = ['structure', 'fear']
const RULE_ORDER = [
  'early_entry', 'no_away_stack', 'size_over_cap', 'be_fear',
  'chased_entry', 'traded_news', 'other',
]

/**
 * A multi-value chooser: pick from a dropdown, see what you picked as pills you
 * can click to drop. `key` names the Set on `state` it fills.
 *
 * Target had this shape alone until SPM-R needed it twice more, for entry
 * trigger and reversion zone. One implementation rather than three, because the
 * three differ only in their vocabulary and in whether a value can be typed:
 * `custom` adds a free-text box (target's hand-typed levels), and `other` names
 * the one option that reveals one (rev zone's `other`).
 */
const chooser = (key, label, values, { custom = '', other = '', otherValue = '' } = {}) => `
  <div class="tag-row">
    <label class="tag-group">
      <span class="tag-label">${label}</span>
      <select class="tag-select" data-add="${esc(key)}">
        <option value="">Add…</option>${options(values)}
      </select>
    </label>
    ${custom
      ? `<label class="tag-group">
      <span class="tag-label">${custom}</span>
      <input type="text" class="tag-input" data-custom="${esc(key)}" placeholder="custom…">
    </label>`
      : ''}
    ${other
      ? `<label class="tag-group" data-other-for="${esc(key)}" hidden>
      <span class="tag-label">${other}</span>
      <input type="text" class="tag-input" id="f-${esc(key)}-other" placeholder="name it…" value="${esc(otherValue)}">
    </label>`
      : ''}
    <div class="tag-group">
      <span class="tag-label">Chosen</span>
      <div class="pill-row" data-chosen="${esc(key)}"></div>
    </div>
  </div>`

/** FlowJournal capitalises these labels while storing the lowercase value. */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

/**
 * Free-typed inputs inside the tag panel, keyed by the name they are held under
 * in `fields`. The panel is re-rendered whenever the model switch moves, which
 * destroys these elements — so their values are harvested into `fields` first
 * and rendered back from it. Without that, switching STDV → MM → STDV would
 * silently empty every number the trader had already typed.
 */
// Declared above TEXT_FIELDS, which names the panel's box: a module-level
// `const` is in its temporal dead zone until its own line runs, so reading it
// from an earlier initialiser throws on import rather than at the call site.
const CONVICTION_IDS = { panel: 'f-spm-conviction', audit: 'f-conviction' }

const TEXT_FIELDS = {
  day_type: '#f-day-type',
  conviction: `#${CONVICTION_IDS.panel}`,
  rev_zone_other: '#f-rev_zone-other',
  stack_ratio: '#f-stack-ratio',
  entry_delay_sec: '#f-entry-delay',
  planned_stop: '#f-planned-stop',
  entry_price: '#f-entry-price',
  actual_exit: '#f-actual-exit',
}

const CHECK_FIELDS = {
  away_stack: '#f-away-stack',
  be_moved: '#f-be-moved',
  news_window: '#f-news-window',
}

/** Shared by every model that has tags at all: STDV, MM and SPM-R all log these. */
const targetRow = () => chooser('target', 'Target', TARGETS, { custom: 'Custom target' })

const beReasonGroup = () => `
  <div class="tag-group" id="grp-be-reason" hidden>
    <span class="tag-label">BE reason</span>
    <div class="pill-row">${inOrder(BE_REASONS, BE_REASON_ORDER).map((v) => pill('be_reason', v, cap(v))).join('')}</div>
  </div>`

const rulesGroup = () => `
  <div class="tag-group">
    <span class="tag-label">Rules broken</span>
    <div class="pill-row">
      ${pill('rule_broken_any', 'yes', 'Yes')}${pill('rule_broken_any', 'no', 'No')}
    </div>
    <div class="pill-row" id="grp-rules-broken" hidden>
      ${inOrder(RULES_BROKEN, RULE_ORDER, (r) => r.value)
        .map((r) => multiPill('rule_broken', r.value, r.label, 'pill-red'))
        .join('')}
    </div>
  </div>`

/**
 * Conviction, 1-10. Rendered inside the tag panel for the models that ask it
 * there (SPM-R), and inside the discretion audit for the ones that do not.
 *
 * Two ids, not one: under SPM-R the hidden audit is still in the DOM, so a
 * shared id would put two of them on the page and leave `$('#f-conviction')`
 * returning whichever happened to come first. `harvest` reads whichever box
 * the current model shows and `renderPanel` writes the value back into the
 * other, so it stays one answer about the trade however you switch models
 * while typing it.
 */
const convictionField = (id, value, cls = '') =>
  `<label class="tag-group${cls ? ` ${cls}` : ''}"><span class="tag-label">Conviction (${CONVICTION_MIN}–${CONVICTION_MAX})</span><input class="tag-input" type="number" id="${id}" min="${CONVICTION_MIN}" max="${CONVICTION_MAX}" step="1" placeholder="1–10" value="${esc(value)}"></label>`

const num = (id, label, value, step = '0.25', placeholder = 'price') =>
  `<label class="tag-group"><span class="tag-label">${label}</span><input class="tag-input" type="number" id="${id}" step="${step}" placeholder="${placeholder}" value="${esc(value)}"></label>`

/** STDV: the original tag set, unchanged. */
const stdvPanel = (fields) => `
  <div class="tag-row">
    <div class="tag-group">
      <span class="tag-label">Setup</span>
      <div class="pill-row">${SETUP_TYPES.map((v) => pill('setup_type', v)).join('')}</div>
    </div>
    <div class="tag-group">
      <span class="tag-label">Band touched</span>
      <div class="pill-row">${inOrder(BANDS, BAND_ORDER).map((v) => multiPill('band_touched', v)).join('')}</div>
    </div>
    <div class="tag-group">
      <span class="tag-label">Regime</span>
      <div class="pill-row">${REGIMES.map((v) => pill('regime', v, cap(v))).join('')}</div>
    </div>
    <label class="tag-group">
      <span class="tag-label">Day type</span>
      <select class="tag-select" id="f-day-type"><option value="">—</option>${options(DAY_TYPES, fields.day_type)}</select>
    </label>
  </div>

  <div class="tag-row">
    <div class="tag-group">
      <span class="tag-label">Gamma regime</span>
      <div class="pill-row">${GAMMA_REGIMES.map((v) => pill('gamma_regime', v, cap(v))).join('')}</div>
    </div>
    <div class="tag-group">
      <span class="tag-label">Major regime</span>
      <div class="pill-row">${pill('major_regime', 'yes', 'Yes')}${pill('major_regime', 'no', 'No')}</div>
    </div>
  </div>

  ${targetRow()}

  <div class="tag-row">
    <label class="tag-toggle"><input type="checkbox" id="f-away-stack"${fields.away_stack ? ' checked' : ''}><span class="tswitch"></span>Away-stack</label>
    ${num('f-stack-ratio', 'Stack ratio', fields.stack_ratio, '0.1', '3.0')}
    ${num('f-entry-delay', 'Entry delay (s)', fields.entry_delay_sec, '1', 'sec')}
    ${num('f-planned-stop', 'Planned stop', fields.planned_stop)}
    <!-- Entry price was MM-only until the points statistics needed it: a stop
         distance is |entry - stop|, so without an entry an STDV trade cannot
         report one. Optional, like every other price here. -->
    ${num('f-entry-price', 'Entry price', fields.entry_price)}
    ${num('f-actual-exit', 'Actual exit', fields.actual_exit)}
  </div>

  <div class="tag-row">
    <label class="tag-toggle"><input type="checkbox" id="f-be-moved"${fields.be_moved ? ' checked' : ''}><span class="tswitch"></span>BE moved</label>
    ${beReasonGroup()}
    <label class="tag-toggle"><input type="checkbox" id="f-news-window"${fields.news_window ? ' checked' : ''}><span class="tswitch"></span>News ±15 min</label>
  </div>

  ${rulesGroup()}`

/**
 * MM: the tags STDV and MM share, plus MM's own four setups and the entry it
 * actually got. No setup A/B/C and no band touched — those are STDV's model,
 * not MM's.
 */
const mmPanel = (fields, mmSetup) => `
  <div class="tag-row">
    <label class="tag-group">
      <span class="tag-label">Setup</span>
      <select class="tag-select" id="f-mm-setup"><option value="">—</option>${options(MM_SETUPS, mmSetup)}</select>
    </label>
    <div class="tag-group">
      <span class="tag-label">Regime</span>
      <div class="pill-row">${REGIMES.map((v) => pill('regime', v, cap(v))).join('')}</div>
    </div>
    <div class="tag-group">
      <span class="tag-label">Gamma regime</span>
      <div class="pill-row">${GAMMA_REGIMES.map((v) => pill('gamma_regime', v, cap(v))).join('')}</div>
    </div>
  </div>

  ${targetRow()}

  <div class="tag-row">
    ${num('f-planned-stop', 'Planned stop', fields.planned_stop)}
    ${num('f-entry-price', 'Entry price', fields.entry_price)}
    ${num('f-actual-exit', 'Actual exit', fields.actual_exit)}
    <label class="tag-toggle"><input type="checkbox" id="f-be-moved"${fields.be_moved ? ' checked' : ''}><span class="tswitch"></span>BE moved</label>
    ${beReasonGroup()}
  </div>

  ${rulesGroup()}`

/**
 * SPM-R: a reversion read. Grade is how good the setup was, rev zone is what it
 * was reverting from, entry trigger is what got it filled and tier is how it
 * was sized.
 *
 * No Regime and no Day type — SPM-R does not read either, and offering them
 * would put an unanswerable question on every entry. Gamma and major regime,
 * target, BE, news and the rules are shared with STDV, so they are the same
 * controls writing the same columns.
 */
const spmPanel = (fields, grade, tier, revZoneOther) => `
  <div class="tag-row">
    <div class="tag-group">
      <span class="tag-label">Grade</span>
      <div class="pill-row">${SPM_GRADES.map((v) => pill('spm_grade', v)).join('')}</div>
    </div>
    <label class="tag-group">
      <span class="tag-label">Tier</span>
      <select class="tag-select" id="f-tier"><option value="">—</option>${options(TIERS, tier)}</select>
    </label>
    <div class="tag-group">
      <span class="tag-label">Gamma regime</span>
      <div class="pill-row">${GAMMA_REGIMES.map((v) => pill('gamma_regime', v, cap(v))).join('')}</div>
    </div>
    <div class="tag-group">
      <span class="tag-label">Major regime</span>
      <div class="pill-row">${pill('major_regime', 'yes', 'Yes')}${pill('major_regime', 'no', 'No')}</div>
    </div>
  </div>

  ${chooser('rev_zone', 'Rev zone', REV_ZONES, { other: 'Other zone', otherValue: revZoneOther })}

  ${chooser('entry_trigger', 'Entry trigger', ENTRY_TRIGGERS)}

  ${targetRow()}

  <div class="tag-row">
    ${num('f-planned-stop', 'Planned stop', fields.planned_stop)}
    ${num('f-entry-price', 'Entry price', fields.entry_price)}
    ${num('f-actual-exit', 'Actual exit', fields.actual_exit)}
  </div>

  <div class="tag-row">
    <label class="tag-toggle"><input type="checkbox" id="f-be-moved"${fields.be_moved ? ' checked' : ''}><span class="tswitch"></span>BE moved</label>
    ${beReasonGroup()}
    <label class="tag-toggle"><input type="checkbox" id="f-news-window"${fields.news_window ? ' checked' : ''}><span class="tswitch"></span>News ±15 min</label>
  </div>

  <div class="tag-row">
    ${rulesGroup()}
    ${convictionField(CONVICTION_IDS.panel, fields.conviction, 'to-right')}
  </div>`

/** `x`: no model tags at all. Thesis, hindsight and a screenshot are the trade. */
const xPanel = () =>
  `<p class="muted-tag">No model tags — thesis, hindsight notes and a screenshot only.</p>`

/**
 * Which panel each model renders. A table rather than a chain of ternaries —
 * the chain was already three deep at MM, and its fallthrough meant any model
 * without an entry silently rendered STDV's tags: the one failure mode that
 * writes the wrong columns without ever looking wrong.
 */
const PANELS = {
  STDV: (st, fields) => stdvPanel(fields),
  MM: (st, fields) => mmPanel(fields, st.mm_setup),
  'SPM-R': (st, fields) => spmPanel(fields, st.spm_grade, st.tier, fields.rev_zone_other),
  x: () => xPanel(),
}

const panel = (state, fields) => (PANELS[state.model] ?? PANELS[DEFAULT_MODEL])(state, fields)

const modelSwitch = (model) => `
  <div class="model-switch" role="radiogroup" aria-label="Trading model">
    ${MODELS.map(
      (m) =>
        `<button type="button" class="seg${m === model ? ' on' : ''}" role="radio" aria-checked="${m === model}" data-model="${esc(m)}">${esc(m)}</button>`
    ).join('')}
  </div>`

const KIND_LABELS = { trade: 'Trade', veto: 'Veto' }

/**
 * The first thing the form asks, because it changes what the rest of the form
 * even means: a trade you took has a P&L, a trade you passed on has an opinion.
 *
 * Rendered as a switch rather than a checkbox — "Veto" unticked would read as a
 * modifier on a trade, and it is not one. It is the other kind of row.
 */
const kindSwitch = (kind) => `
  <div class="full field kind-field">
    <div class="kind-switch" role="radiogroup" aria-label="Entry kind">
      ${KINDS.map(
        (k) =>
          `<button type="button" class="seg seg-${esc(k)}${k === kind ? ' on' : ''}" role="radio"
                   aria-checked="${k === kind}" data-kind="${esc(k)}">${esc(KIND_LABELS[k])}</button>`
      ).join('')}
    </div>
    <p class="kind-hint" id="kind-hint"></p>
  </div>`

const KIND_HINTS = {
  trade: 'A position you actually took. Counts toward P&L, win rate and trade count.',
  veto: 'An idea you passed on. No P&L, no win rate, no trade count — just the reasoning and what it would have done.',
}

/** Veto only: what the idea would have done. Replaces Status, which needs a fill. */
const outcomeField = () => `
  <div class="full field" id="w-outcome" hidden>
    <span class="form-label">Outcome — would have been</span>
    <div class="pill-row">
      ${VETO_OUTCOMES.map((v) => pill('veto_outcome', v, VETO_OUTCOME_LABELS[v])).join('')}
    </div>
  </div>`

/**
 * The discretion audit: would a strict mechanical run have fired here, and what
 * would it have made. Asked on STDV and MM, where the question is about how far
 * the decision drifted from the model.
 *
 * SPM-R does not ask it — the block is hidden for that model and its columns
 * are written null. Conviction is the exception: that one is a property of the
 * decision whatever the model, so SPM-R keeps it in its own tag box.
 *
 * Sits outside `#tag-panel` on purpose: the panel is destroyed and rebuilt on
 * every model switch, and these answers must survive that. Nothing here but
 * conviction is harvested into `fields` for the same reason — the elements are
 * never replaced, so `save` reads them straight off the DOM.
 */
const discretionBlock = (t) => `
  <div class="tags disc full" id="w-discretion">
    <div class="tags-head">
      <span>Discretion audit</span>
    </div>

    <div class="tag-row">
      ${convictionField(CONVICTION_IDS.audit, t.conviction ?? '')}
      <div class="tag-group">
        <span class="tag-label">Mech trigger</span>
        <div class="pill-row">${MECH_TRIGGERS.map((v) => pill('mech_trigger', v, cap(v))).join('')}</div>
      </div>
      ${num('f-mech-cf-r', 'Mech counterfactual R', t.mech_counterfactual_r ?? '', '0.1', 'e.g. 1.8')}
    </div>

    <div class="tag-group">
      <span class="tag-label">Discretionary act</span>
      <div class="pill-row">
        ${DISCRETIONARY_ACTS.map((a) => multiPill('discretionary_act', a.value, a.label)).join('')}
      </div>
    </div>

    <div class="tag-row">
      ${num('f-mech-entry', 'Mech entry', t.mech_entry ?? '')}
      ${num('f-mech-stop', 'Mech stop', t.mech_stop ?? '')}
      ${num('f-mech-target', 'Mech target', t.mech_target ?? '')}
      ${num('f-mech-exit', 'Mech exit', t.mech_exit ?? '')}
    </div>
  </div>`

/**
 * The account this trade was taken on. Optional — every trade logged before
 * accounts existed has none, and "—" has to stay a legal answer or editing an
 * old trade would force one on it.
 *
 * `selected` is the trade's own account when editing, and the last account used
 * when logging a new one: the trader is almost always on the same account they
 * were on an hour ago, and a wrong default is one dropdown away from right.
 */
const accountField = (accounts, selected, scope) => {
  // In the Backtest journal "no account" is not an available answer. An
  // unassigned trade belongs to the live journal by definition (see byScope in
  // filters.js), so saving one here would file a simulated fill among real
  // ones — the exact leak the two journals exist to prevent.
  const backtest = scope === SCOPES.BACKTEST
  const blank = accounts.length
    ? backtest
      ? 'Pick a backtest account'
      : '—'
    : backtest
      ? 'No backtest accounts yet'
      : 'No accounts yet'

  return `
  <label>Account${backtest ? ' <span class="req">required</span>' : ''}
    <select id="f-account">
      <option value=""${selected ? '' : ' selected'}>${blank}</option>
      ${accounts
        .map(
          (a) =>
            `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`
        )
        .join('')}
    </select>
  </label>`
}

function template(trade, model, accounts, account, scope) {
  const backtest = scope === SCOPES.BACKTEST
  const noun = backtest ? 'backtest entry' : 'trade'

  return `
  <div class="modal">
    <header class="modal-head">
      <h2>${trade.id ? 'Edit' : 'Log'} ${esc(noun)}${backtest ? ' <span class="badge acct-backtest">Backtest</span>' : ''}</h2>
      <button type="button" class="ghost icon" data-act="close" aria-label="Close">${CLOSE_ICON}</button>
    </header>

    <div class="modal-body">
      <div class="grid">
        ${kindSwitch(tradeKind(trade))}
        <label>Direction<select id="f-type">${options(TYPES, trade.type)}</select></label>
        <label>Date &amp; Time<input type="datetime-local" id="f-date" value="${esc(trade.date || toDatetimeLocal())}"></label>
        <label id="w-status">Status<select id="f-status">${options(STATUSES, trade.status)}</select></label>
        <label id="w-pnl">P&amp;L ($)<input type="number" id="f-pnl" step="0.01" placeholder="e.g. 250 or -120" value="${trade.pnl ?? ''}"></label>
        <label id="w-risk">Risk ($)<input type="number" id="f-risk" step="0.01" placeholder="Amount risked" value="${trade.risk ?? ''}"></label>
        <label id="w-rr">RR (Risk/Reward)<input type="number" id="f-rr" step="0.1" placeholder="e.g. 2.5" value="${trade.rr ?? ''}"></label>
        <button type="button" class="ghost" id="w-calc" data-act="calc-rr">Auto-calc RR from |P&amp;L| ÷ Risk</button>
        ${outcomeField()}
        ${accountField(accounts, account, scope)}

        <div class="tags">
          <div class="tags-head">
            <span>Model tags</span>
            ${modelSwitch(model)}
          </div>
          <div class="tag-panel" id="tag-panel"></div>
        </div>

        ${discretionBlock(trade)}

        <label class="full">Thesis<textarea id="f-thesis" placeholder="Why did you take this trade? What was the setup, flow, confluence...">${esc(trade.thesis ?? '')}</textarea></label>
        <label class="full">Hindsight notes<textarea id="f-hindsight" placeholder="Post-trade reflection. What worked, what didn't, what you missed...">${esc(trade.hindsight ?? '')}</textarea></label>

        <div class="full field">
          <span class="form-label">Screenshot</span>
          <div id="upload-wrap"></div>
          <input type="file" id="f-image" accept="image/*" hidden>
        </div>
      </div>

      <p class="err" id="form-err"></p>
    </div>

    <footer class="modal-foot">
      ${trade.id ? '<button type="button" class="ghost danger" data-act="delete">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="ghost" data-act="close">Cancel</button>
      <button type="button" data-act="save" id="f-save">Save</button>
    </footer>
  </div>`
}

/**
 * Opens the add/edit modal. `trade` is a partial app-shaped trade; omit it to
 * create. Calls `onSaved()` after a successful save or delete.
 */
export async function openTradeForm({ trade = {}, onSaved, scope = SCOPES.LIVE } = {}) {
  // Editing needs the heavy fields the list query leaves out.
  const [full, allAccounts] = await Promise.all([
    trade.id ? getTrade(trade.id).then((t) => t ?? trade) : Promise.resolve(trade),
    // A failed account fetch must not block logging a trade: the field falls
    // back to an empty list, which renders as "No accounts yet".
    listAccounts().catch(() => []),
  ])

  // Only the accounts of the journal you are standing in. The dropdown is the
  // one place the two could be mixed, so it is the one place that has to filter
  // — and both directions matter: a live trade must not be filed to a backtest
  // account any more than the reverse.
  const backtestIds = backtestAccountIds(allAccounts)
  const wantBacktest = scope === SCOPES.BACKTEST
  const accounts = allAccounts.filter((a) => backtestIds.has(a.id) === wantBacktest)

  const accountIds = accounts.map((a) => a.id)
  const account = full.id ? (full.account_id ?? '') : lastUsedAccount(accountIds, scope)

  const state = {
    kind: tradeKind(full),
    veto_outcome: full.veto_outcome ?? null,
    mech_trigger: full.mech_trigger ?? null,
    discretionary_act: new Set(full.discretionary_act ?? []),
    // Null on every trade logged before the model switch existed — and those
    // are all STDV, since STDV's tags were the only ones the form offered.
    model: full.model || DEFAULT_MODEL,
    setup_type: full.setup_type ?? null,
    mm_setup: full.mm_setup ?? null,
    spm_grade: full.spm_grade ?? null,
    tier: full.tier ?? null,
    entry_trigger: new Set(full.entry_trigger ?? []),
    // Like `target`, this holds vocabulary values and one hand-typed zone
    // alike. A stored zone that is not in REV_ZONES *is* the typed one, so
    // `other` is re-selected for it below — otherwise editing a trade would
    // show the text box closed over a value the trade is actually carrying.
    rev_zone: new Set(full.rev_zone ?? []),
    band_touched: new Set(full.band_touched ?? []),
    // Holds suggestions and hand-typed levels alike — the column is free text.
    target: new Set(full.target ?? []),
    regime: full.regime ?? null,
    gamma_regime: full.gamma_regime ?? null,
    // Stored as a nullable boolean; the form speaks yes/no/unanswered.
    major_regime: full.major_regime == null ? null : full.major_regime ? 'yes' : 'no',
    be_reason: full.be_reason ?? null,
    rule_broken: new Set(full.rule_broken ?? []),
    // Gates the rule pills. Not a stored field — `rule_broken` alone is what
    // gets saved, and an empty array already means "none broken". On an
    // existing trade the stored array answers the question; a new one starts
    // unanswered rather than presuming a "no".
    rule_broken_any: full.id ? (full.rule_broken?.length ? 'yes' : 'no') : null,
    // Up to MAX_IMAGES screenshots. `fromRow` already widened a pre-`images`
    // row's single `image` into a one-element list, so nothing here special-
    // cases the old column.
    images: [...(full.images ?? [])],
  }

  // A stored zone that is no REV_ZONES value is the one that was typed into the
  // `other` box. It moves back into the box and `other` is re-selected for it,
  // so editing a trade shows the same two controls that wrote it — rather than
  // a stray pill beside a closed box, or a closed box over a zone the trade is
  // actually carrying.
  const typedZone = [...state.rev_zone].find((v) => !REV_ZONES.includes(v)) ?? ''
  if (typedZone) {
    state.rev_zone.delete(typedZone)
    state.rev_zone.add(REV_ZONE_OTHER)
  }

  /** Panel inputs, held outside the DOM so a model switch cannot erase them. */
  const fields = {
    day_type: full.day_type ?? '',
    conviction: full.conviction ?? '',
    rev_zone_other: typedZone,
    stack_ratio: full.stack_ratio ?? '',
    entry_delay_sec: full.entry_delay_sec ?? '',
    planned_stop: full.planned_stop ?? '',
    entry_price: full.entry_price ?? '',
    actual_exit: full.actual_exit ?? '',
    away_stack: !!full.away_stack,
    be_moved: !!full.be_moved,
    news_window: !!full.news_window,
  }

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.innerHTML = template(full, state.model, accounts, account, scope)
  document.body.append(overlay)

  const $ = (sel) => overlay.querySelector(sel)
  const err = $('#form-err')

  /** Copies what is on screen into `fields`. Inputs the current model does not
   *  render are simply absent, so their last value survives untouched. */
  function harvest() {
    for (const [key, sel] of Object.entries(TEXT_FIELDS)) {
      const el = $(sel)
      if (el) fields[key] = el.value
    }
    // The audit's conviction box, when that is the one on screen. TEXT_FIELDS
    // names the panel's, and taking this one too is what makes the value
    // survive a switch in either direction.
    const audit = $(`#${CONVICTION_IDS.audit}`)
    if (audit && !$('#w-discretion').hidden) fields.conviction = audit.value
    for (const [key, sel] of Object.entries(CHECK_FIELDS)) {
      const el = $(sel)
      if (el) fields[key] = el.checked
    }
  }

  /** Re-renders the tag panel for the current model and rebinds what it owns. */
  function renderPanel() {
    $('#tag-panel').innerHTML = panel(state, fields)

    // SPM-R asks conviction in its own tag box and nothing else from the audit,
    // so the block is hidden rather than removed: switching back to STDV must
    // find the mech prices still holding what was typed into them.
    const disc = $('#w-discretion')
    disc.hidden = state.model === 'SPM-R'
    // The audit's own conviction box is never re-rendered, so the value has to
    // be written back into it — otherwise typing 7 under SPM-R and switching to
    // STDV would show an empty box over a conviction the trade still carries.
    if (!disc.hidden) $(`#${CONVICTION_IDS.audit}`).value = fields.conviction

    for (const el of overlay.querySelectorAll('.seg[data-model]')) {
      const on = el.dataset.model === state.model
      el.classList.toggle('on', on)
      el.setAttribute('aria-checked', String(on))
    }

    $('#f-be-moved')?.addEventListener('change', syncPills)
    $('#f-mm-setup')?.addEventListener('change', (e) => {
      state.mm_setup = e.target.value || null
    })
    $('#f-tier')?.addEventListener('change', (e) => {
      state.tier = e.target.value || null
    })

    // Picking from a chooser's dropdown adds the value and resets the control,
    // so the same list can be used again for a second one.
    for (const sel of overlay.querySelectorAll('select[data-add]')) {
      sel.addEventListener('change', (e) => {
        if (addValue(e.target.dataset.add, e.target.value)) syncPills()
        e.target.value = ''
      })
    }

    // Enter commits a hand-typed value. Without this the form would
    // submit-by-habit and the typed level would sit in the box unrecorded
    // until save.
    for (const input of overlay.querySelectorAll('input[data-custom]')) {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        if (addValue(e.target.dataset.custom, e.target.value)) {
          e.target.value = ''
          syncPills()
        }
      })
    }

    syncPills()
  }

  function setModel(model) {
    if (model === state.model) return
    harvest()
    state.model = model
    renderPanel()
  }

  /**
   * Shows the fields the current kind can honestly answer, and hides the rest.
   *
   * Toggles `hidden` rather than re-rendering: switching Trade → Veto → Trade
   * must not empty a P&L the trader already typed, and the discretion block
   * below is shared by both kinds, so rebuilding the body would cost those
   * answers too.
   */
  function applyKind() {
    const veto = state.kind === 'veto'

    // P&L, Risk, RR and Status all describe a fill. A veto has none.
    for (const sel of ['#w-pnl', '#w-risk', '#w-rr', '#w-calc', '#w-status']) {
      $(sel).hidden = veto
    }
    $('#w-outcome').hidden = !veto

    $('#kind-hint').textContent = KIND_HINTS[state.kind]
    $('#f-save').textContent = veto ? 'Save veto' : 'Save trade'

    for (const el of overlay.querySelectorAll('.seg[data-kind]')) {
      const on = el.dataset.kind === state.kind
      el.classList.toggle('on', on)
      el.setAttribute('aria-checked', String(on))
    }

    overlay.querySelector('.modal').classList.toggle('is-veto', veto)
  }

  function setKind(kind) {
    if (kind === state.kind) return
    state.kind = kind
    applyKind()
    syncPills()
  }

  /**
   * Keeps "none" exclusive. Answering "none" and "size adjusted" at once is not
   * a state the reader can make sense of, so the newest click wins: picking any
   * act drops "none", and picking "none" drops everything else.
   */
  function toggleDiscretionaryAct(value) {
    const set = state.discretionary_act
    if (set.has(value)) return void set.delete(value)

    if (value === 'none') set.clear()
    else set.delete('none')
    set.add(value)
  }

  function syncPills() {
    for (const el of overlay.querySelectorAll('.pill[data-key]')) {
      el.classList.toggle('on', state[el.dataset.key] === el.dataset.val)
    }
    // `data-multi` names the Set on `state` it belongs to, so band_touched and
    // rule_broken share one implementation.
    for (const el of overlay.querySelectorAll('.pill[data-multi]')) {
      el.classList.toggle('on', state[el.dataset.multi].has(el.dataset.val))
    }
    // Every group below is model-specific: `x` renders none of them.
    const beReason = $('#grp-be-reason')
    if (beReason) beReason.hidden = !$('#f-be-moved')?.checked
    const rules = $('#grp-rules-broken')
    if (rules) rules.hidden = state.rule_broken_any !== 'yes'
    // The free-text box a chooser opens for one named option — rev zone's
    // `other`. Hidden until that option is picked, so the box can never hold a
    // zone the trade does not claim.
    for (const box of overlay.querySelectorAll('[data-other-for]')) {
      box.hidden = !state[box.dataset.otherFor]?.has(REV_ZONE_OTHER)
    }
    renderChosen()
  }

  /**
   * Every chooser's chosen values, as pills you can click to remove. The
   * dropdown and the free-text box both feed the same Set, so a trade can
   * carry a suggestion and a hand-typed level at once.
   */
  function renderChosen() {
    for (const box of overlay.querySelectorAll('[data-chosen]')) {
      const key = box.dataset.chosen
      const chosen = [...state[key]]
      box.innerHTML = chosen.length
        ? chosen
            .map(
              (v) =>
                `<button type="button" class="pill on" data-drop-key="${esc(key)}" data-drop-val="${esc(v)}">${esc(v)} ✕</button>`
            )
            .join('')
        : '<span class="muted-tag">None</span>'
    }
  }

  /** Adds a value to a chooser's Set if it is non-empty and not already there. */
  function addValue(key, value) {
    const v = String(value ?? '').trim()
    if (v) state[key].add(v)
    return !!v
  }

  /**
   * Resolves rev zone's `other` into the zone that was actually typed.
   *
   * The column stores zones, not a flag plus a note, so a named zone has to
   * land in the array the same way a picked one does. Any previously typed
   * zone is dropped first, or editing the box would leave both spellings on
   * the trade. An empty box leaves the bare `other` standing: that reads as
   * "a zone I did not name", which is true, and beats dropping the answer.
   */
  function commitTypedZone() {
    for (const v of [...state.rev_zone]) {
      if (!REV_ZONES.includes(v)) state.rev_zone.delete(v)
    }
    const typed = String(fields.rev_zone_other ?? '').trim()
    if (typed && state.rev_zone.has(REV_ZONE_OTHER)) {
      state.rev_zone.delete(REV_ZONE_OTHER)
      state.rev_zone.add(typed)
    }
  }

  const UPLOAD_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'

  /**
   * The screenshots, as a gallery with one slot per image and an upload tile
   * while there is room for another.
   *
   * `data-i` on each remove button is the index, not the data URI: two shots of
   * the same chart compress to the same bytes often enough that dropping "the
   * one that matches" would take both.
   */
  function renderUpload() {
    const wrap = $('#upload-wrap')
    const shots = state.images.map(
      (src, i) =>
        `<div class="preview"><img src="${src}" alt="Chart screenshot ${i + 1}"><button type="button" class="ghost icon" data-act="clear-image" data-i="${i}" aria-label="Remove screenshot ${i + 1}">${CLOSE_ICON}</button><span class="muted">${Math.round(dataUrlBytes(src) / 1024)} KB</span></div>`
    )

    if (state.images.length < MAX_IMAGES) {
      shots.push(
        `<button type="button" class="upload" data-act="pick-image">${UPLOAD_ICON}${
          state.images.length
            ? `Add another (${state.images.length}/${MAX_IMAGES})`
            : 'Click to upload, or paste a chart screenshot'
        }</button>`
      )
    }

    wrap.innerHTML = `<div class="shots${state.images.length ? ' has-shots' : ''}">${shots.join('')}</div>`
  }

  async function useImageFile(file) {
    if (!isImageFile(file)) return
    // Refused rather than silently dropped, and refused before compressing, so
    // a paste into a full gallery says why instead of appearing to do nothing.
    if (state.images.length >= MAX_IMAGES) {
      err.textContent = `${MAX_IMAGES} screenshots is the limit — remove one first`
      return
    }
    err.textContent = 'Compressing…'
    try {
      state.images.push(await compressImage(file))
      err.textContent = ''
      renderUpload()
    } catch (e) {
      err.textContent = `Could not read that image: ${e.message}`
    }
  }

  function close() {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('paste', onPaste)
  }

  function onKey(e) {
    if (e.key === 'Escape') close()
  }

  function onPaste(e) {
    const file = [...(e.clipboardData?.items ?? [])]
      .find((i) => i.type.startsWith('image/'))
      ?.getAsFile()
    if (file) useImageFile(file)
  }

  async function save(button) {
    button.disabled = true
    err.textContent = ''
    try {
      const date = $('#f-date').value
      // `date` is a text column and the list sorts on it lexicographically, so
      // an empty or malformed value would land the row in the wrong place.
      if (!isValidTradeDate(date)) {
        throw new Error('Pick a date and time for this trade')
      }

      const accountId = $('#f-account').value || null

      // See accountField: an unassigned row lands in the live journal, so in the
      // Backtest journal saving without an account would file a simulated fill
      // among real ones. Refused rather than silently redirected.
      if (scope === SCOPES.BACKTEST && !accountId) {
        throw new Error(
          accounts.length
            ? 'Pick a backtest account — a backtest entry with no account would show up in the live journal'
            : 'Create a backtest account first: Accounts → New account → Backtest'
        )
      }

      harvest()
      // A value left typed in a chooser's box but never committed with Enter
      // would otherwise be silently dropped on save.
      for (const input of overlay.querySelectorAll('input[data-custom]')) {
        addValue(input.dataset.custom, input.value)
      }
      commitTypedZone()

      // A veto has no fill, so it has no P&L, risk, RR or status — and those are
      // zeroed here rather than merely hidden, so that flipping a mistyped trade
      // to a veto cannot leave a stale $250 on the row for the tiles to find.
      const veto = state.kind === 'veto'

      // Only the active model's tags are written. Switching a trade to another
      // model clears what the form no longer shows, rather than leaving the old
      // model's tags behind on a row that no longer displays them.
      const stdv = state.model === 'STDV'
      const mm = state.model === 'MM'
      const spm = state.model === 'SPM-R'
      const tagged = stdv || mm || spm
      // Which models render which shared control. Not every tagged model asks
      // every shared question: SPM-R has no Regime or Day type panel, and MM
      // has no Major regime or News one, so writing those from `tagged` would
      // save an answer the trader was never shown.
      const regimed = stdv || mm
      const majored = stdv || spm
      const beMoved = tagged && fields.be_moved

      await upsertTrade({
        id: full.id,
        num: full.num ?? (await nextTradeNum()),
        date,
        type: $('#f-type').value,
        kind: state.kind,
        status: veto ? null : $('#f-status').value,
        veto_outcome: veto ? state.veto_outcome : null,
        pnl: veto ? 0 : parseFloat($('#f-pnl').value) || 0,
        risk: veto ? 0 : parseFloat($('#f-risk').value) || 0,
        rr: veto ? 0 : parseFloat($('#f-rr').value) || 0,
        thesis: $('#f-thesis').value.trim(),
        hindsight: $('#f-hindsight').value.trim(),
        // `image` stays the first screenshot so FlowJournal and anything else
        // reading the old column still finds one. See mapping.js.
        image: state.images[0] ?? null,
        images: [...state.images],
        model: state.model,
        setup_type: stdv ? state.setup_type : null,
        mm_setup: mm ? state.mm_setup : null,
        spm_grade: spm ? state.spm_grade : null,
        tier: spm ? state.tier : null,
        entry_trigger: spm ? [...state.entry_trigger] : [],
        rev_zone: spm ? [...state.rev_zone] : [],
        band_touched: stdv ? [...state.band_touched] : [],
        away_stack: stdv && fields.away_stack,
        stack_ratio: stdv ? numOrNull(fields.stack_ratio) : null,
        entry_delay_sec: stdv ? numOrNull(fields.entry_delay_sec) : null,
        planned_stop: tagged ? numOrNull(fields.planned_stop) : null,
        // Both tagged models now, not MM alone — see the note in stdvPanel.
        entry_price: tagged ? numOrNull(fields.entry_price) : null,
        actual_exit: tagged ? numOrNull(fields.actual_exit) : null,
        target: tagged ? [...state.target] : [],
        be_moved: beMoved,
        // FlowJournal drops the reason when BE wasn't moved; keep that.
        be_reason: beMoved ? state.be_reason : null,
        regime: regimed ? state.regime : null,
        gamma_regime: tagged ? state.gamma_regime : null,
        major_regime: majored
          ? state.major_regime == null
            ? null
            : state.major_regime === 'yes'
          : null,
        day_type: stdv ? fields.day_type || null : null,
        news_window: majored && fields.news_window,
        rule_broken: tagged ? [...state.rule_broken] : [],
        account_id: accountId,

        // Conviction is asked on every model — in the audit block for STDV and
        // MM, in the tag box for SPM-R — and `harvest` has already taken it
        // from whichever box was on screen. It is not cleared by the model
        // switch or the kind switch: how convinced you were is a question
        // about the decision, not about the model.
        conviction: normaliseConviction(fields.conviction),

        // The rest of the audit. SPM-R never shows these, so they are written
        // null rather than read off the hidden block — the same rule the model
        // tags follow above, and for the same reason: a trade must not carry an
        // answer the form did not put in front of you.
        mech_trigger: spm ? null : state.mech_trigger,
        discretionary_act: spm ? [] : [...state.discretionary_act],
        mech_counterfactual_r: spm ? null : numOrNull($('#f-mech-cf-r').value),
        mech_entry: spm ? null : numOrNull($('#f-mech-entry').value),
        mech_stop: spm ? null : numOrNull($('#f-mech-stop').value),
        mech_target: spm ? null : numOrNull($('#f-mech-target').value),
        mech_exit: spm ? null : numOrNull($('#f-mech-exit').value),
      })
      // Only remembered once the save succeeded, and only when an account was
      // actually picked — clearing the field is not a new default.
      if (accountId) rememberLastUsedAccount(accountId, scope)
      close()
      onSaved?.()
    } catch (e) {
      err.textContent = e.message || 'Save failed'
      button.disabled = false
    }
  }

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) return close()

    const kindSeg = e.target.closest('.seg[data-kind]')
    if (kindSeg) return setKind(kindSeg.dataset.kind)

    const seg = e.target.closest('.seg[data-model]')
    if (seg) return setModel(seg.dataset.model)

    const p = e.target.closest('.pill')
    if (p) {
      if (p.dataset.dropKey) {
        state[p.dataset.dropKey].delete(p.dataset.dropVal)
      } else if (p.dataset.multi === 'discretionary_act') {
        toggleDiscretionaryAct(p.dataset.val)
      } else if (p.dataset.multi) {
        const set = state[p.dataset.multi]
        set.has(p.dataset.val) ? set.delete(p.dataset.val) : set.add(p.dataset.val)
      } else {
        // Clicking the selected pill again clears it, as in FlowJournal.
        state[p.dataset.key] = state[p.dataset.key] === p.dataset.val ? null : p.dataset.val
        // Answering anything but "yes" drops the rules already picked, so the
        // hidden pills can't save something the form no longer shows.
        if (p.dataset.key === 'rule_broken_any' && state.rule_broken_any !== 'yes') {
          state.rule_broken.clear()
        }
      }
      return syncPills()
    }

    const act = e.target.closest('[data-act]')?.dataset.act
    if (act === 'close') close()
    else if (act === 'delete') {
      if (!confirm('Delete this trade? This cannot be undone.')) return
      await deleteTrade(full.id)
      close()
      onSaved?.()
    } else if (act === 'save') save(e.target.closest('[data-act]'))
    else if (act === 'pick-image') $('#f-image').click()
    else if (act === 'clear-image') {
      state.images.splice(Number(e.target.closest('[data-act]').dataset.i), 1)
      renderUpload()
    } else if (act === 'calc-rr') {
      const pnl = parseFloat($('#f-pnl').value)
      const risk = parseFloat($('#f-risk').value)
      if (!Number.isNaN(pnl) && risk > 0) $('#f-rr').value = (Math.abs(pnl) / risk).toFixed(2)
      else err.textContent = 'Enter P&L and a non-zero risk first'
    }
  })

  $('#f-image').addEventListener('change', (e) => {
    useImageFile(e.target.files[0])
    // Cleared so picking the same file again still fires a change event, which
    // it would not if the input kept holding it.
    e.target.value = ''
  })
  document.addEventListener('keydown', onKey)
  document.addEventListener('paste', onPaste)

  applyKind()
  renderPanel()
  renderUpload()
  $('#f-date').focus()
}
