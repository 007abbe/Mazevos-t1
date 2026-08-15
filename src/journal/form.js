import {
  TYPES, STATUSES, MODELS, DEFAULT_MODEL, SETUP_TYPES, MM_SETUPS, BANDS, TARGETS,
  REGIMES, GAMMA_REGIMES, BE_REASONS, DAY_TYPES, RULES_BROKEN,
} from '../domain/trade-vocab.js'
import { upsertTrade, deleteTrade, getTrade, nextTradeNum } from './trades.js'
import { listAccounts, lastUsedAccount, rememberLastUsedAccount } from './accounts.js'
import { toDatetimeLocal, isValidTradeDate } from './mapping.js'
import { compressImage, dataUrlBytes, isImageFile } from './screenshots.js'

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
const inOrder = (values, order) => {
  const rank = (v) => (order.indexOf(v) < 0 ? order.length : order.indexOf(v))
  return [...values].sort((a, b) => rank(a) - rank(b))
}

const BAND_ORDER = ['+2σ', '+2.6σ', '-2σ', '-2.6σ']
const BE_REASON_ORDER = ['structure', 'fear']
const RULE_ORDER = [
  'early_entry', 'no_away_stack', 'size_over_cap', 'be_fear',
  'chased_entry', 'traded_news', 'other',
]

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
const TEXT_FIELDS = {
  day_type: '#f-day-type',
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

/** Shared by every model that has tags at all: STDV and MM both log these. */
const targetRow = () => `
  <div class="tag-row">
    <label class="tag-group">
      <span class="tag-label">Target</span>
      <select class="tag-select" id="f-target-add">
        <option value="">Add…</option>${options(TARGETS)}
      </select>
    </label>
    <label class="tag-group">
      <span class="tag-label">Custom target</span>
      <input type="text" id="f-target-custom" class="tag-input" placeholder="custom…">
    </label>
    <div class="tag-group">
      <span class="tag-label">Chosen</span>
      <div class="pill-row" id="target-chosen"></div>
    </div>
  </div>`

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
      ${inOrder(RULES_BROKEN.map((r) => r.value), RULE_ORDER)
        .map((v) => `<button type="button" class="pill pill-red" data-multi="rule_broken" data-val="${esc(v)}">${esc(v)}</button>`)
        .join('')}
    </div>
  </div>`

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

/** `x`: no model tags at all. Thesis, hindsight and a screenshot are the trade. */
const xPanel = () =>
  `<p class="muted-tag">No model tags — thesis, hindsight notes and a screenshot only.</p>`

const panel = (model, fields, mmSetup) =>
  model === 'MM' ? mmPanel(fields, mmSetup) : model === 'x' ? xPanel() : stdvPanel(fields)

const modelSwitch = (model) => `
  <div class="model-switch" role="radiogroup" aria-label="Trading model">
    ${MODELS.map(
      (m) =>
        `<button type="button" class="seg${m === model ? ' on' : ''}" role="radio" aria-checked="${m === model}" data-model="${esc(m)}">${esc(m)}</button>`
    ).join('')}
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
const accountField = (accounts, selected) => `
  <label>Account
    <select id="f-account">
      <option value=""${selected ? '' : ' selected'}>${accounts.length ? '—' : 'No accounts yet'}</option>
      ${accounts
        .map(
          (a) =>
            `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`
        )
        .join('')}
    </select>
  </label>`

function template(trade, model, accounts, account) {
  return `
  <div class="modal">
    <header class="modal-head">
      <h2>${trade.id ? 'Edit trade' : 'Log trade'}</h2>
      <button type="button" class="ghost icon" data-act="close" aria-label="Close">${CLOSE_ICON}</button>
    </header>

    <div class="modal-body">
      <div class="grid">
        <label>Direction<select id="f-type">${options(TYPES, trade.type)}</select></label>
        <label>Date &amp; Time<input type="datetime-local" id="f-date" value="${esc(trade.date || toDatetimeLocal())}"></label>
        <label>Status<select id="f-status">${options(STATUSES, trade.status)}</select></label>
        <label>P&amp;L ($)<input type="number" id="f-pnl" step="0.01" placeholder="e.g. 250 or -120" value="${trade.pnl ?? ''}"></label>
        <label>Risk ($)<input type="number" id="f-risk" step="0.01" placeholder="Amount risked" value="${trade.risk ?? ''}"></label>
        <label>RR (Risk/Reward)<input type="number" id="f-rr" step="0.1" placeholder="e.g. 2.5" value="${trade.rr ?? ''}"></label>
        <button type="button" class="ghost" data-act="calc-rr">Auto-calc RR from |P&amp;L| ÷ Risk</button>
        ${accountField(accounts, account)}

        <div class="tags">
          <div class="tags-head">
            <span>Model tags</span>
            ${modelSwitch(model)}
          </div>
          <div class="tag-panel" id="tag-panel"></div>
        </div>

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
      <button type="button" data-act="save">Save trade</button>
    </footer>
  </div>`
}

/**
 * Opens the add/edit modal. `trade` is a partial app-shaped trade; omit it to
 * create. Calls `onSaved()` after a successful save or delete.
 */
export async function openTradeForm({ trade = {}, onSaved } = {}) {
  // Editing needs the heavy fields the list query leaves out.
  const [full, accounts] = await Promise.all([
    trade.id ? getTrade(trade.id).then((t) => t ?? trade) : Promise.resolve(trade),
    // A failed account fetch must not block logging a trade: the field falls
    // back to an empty list, which renders as "No accounts yet".
    listAccounts().catch(() => []),
  ])

  const accountIds = accounts.map((a) => a.id)
  const account = full.id ? (full.account_id ?? '') : lastUsedAccount(accountIds)

  const state = {
    // Null on every trade logged before the model switch existed — and those
    // are all STDV, since STDV's tags were the only ones the form offered.
    model: full.model || DEFAULT_MODEL,
    setup_type: full.setup_type ?? null,
    mm_setup: full.mm_setup ?? null,
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
    image: full.image ?? null,
  }

  /** Panel inputs, held outside the DOM so a model switch cannot erase them. */
  const fields = {
    day_type: full.day_type ?? '',
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
  overlay.innerHTML = template(full, state.model, accounts, account)
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
    for (const [key, sel] of Object.entries(CHECK_FIELDS)) {
      const el = $(sel)
      if (el) fields[key] = el.checked
    }
  }

  /** Re-renders the tag panel for the current model and rebinds what it owns. */
  function renderPanel() {
    $('#tag-panel').innerHTML = panel(state.model, fields, state.mm_setup)

    for (const el of overlay.querySelectorAll('.seg[data-model]')) {
      const on = el.dataset.model === state.model
      el.classList.toggle('on', on)
      el.setAttribute('aria-checked', String(on))
    }

    $('#f-be-moved')?.addEventListener('change', syncPills)
    $('#f-mm-setup')?.addEventListener('change', (e) => {
      state.mm_setup = e.target.value || null
    })

    // Picking from the dropdown adds a target and resets the control, so the
    // same list can be used again for a second one.
    $('#f-target-add')?.addEventListener('change', (e) => {
      if (addTarget(e.target.value)) syncPills()
      e.target.value = ''
    })

    // Enter commits a custom target. Without this the form would submit-by-habit
    // and the typed level would sit in the box unrecorded until save.
    $('#f-target-custom')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (addTarget(e.target.value)) {
        e.target.value = ''
        syncPills()
      }
    })

    syncPills()
  }

  function setModel(model) {
    if (model === state.model) return
    harvest()
    state.model = model
    renderPanel()
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
    renderTargets()
  }

  /**
   * Chosen targets, as pills you can click to remove. The dropdown and the
   * custom field both feed this set, so a trade can carry a suggestion and a
   * hand-typed level at once.
   */
  function renderTargets() {
    const box = $('#target-chosen')
    if (!box) return
    const chosen = [...state.target]
    box.innerHTML = chosen.length
      ? chosen
          .map((v) => `<button type="button" class="pill on" data-drop-target="${esc(v)}">${esc(v)} ✕</button>`)
          .join('')
      : '<span class="muted-tag">None</span>'
  }

  /** Adds a target if it is non-empty and not already chosen. */
  function addTarget(value) {
    const v = String(value ?? '').trim()
    if (v) state.target.add(v)
    return !!v
  }

  function renderUpload() {
    const wrap = $('#upload-wrap')
    if (state.image) {
      const kb = Math.round(dataUrlBytes(state.image) / 1024)
      wrap.innerHTML = `<div class="preview"><img src="${state.image}" alt="Chart screenshot"><button type="button" class="ghost icon" data-act="clear-image" aria-label="Remove">${CLOSE_ICON}</button><span class="muted">${kb} KB</span></div>`
    } else {
      wrap.innerHTML = `<button type="button" class="upload" data-act="pick-image"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>Click to upload, or paste a chart screenshot</button>`
    }
  }

  async function useImageFile(file) {
    if (!isImageFile(file)) return
    err.textContent = 'Compressing…'
    try {
      state.image = await compressImage(file)
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

      harvest()
      // A custom target left typed but never committed with Enter would
      // otherwise be silently dropped on save.
      addTarget($('#f-target-custom')?.value)

      // Only the active model's tags are written. Switching a trade to another
      // model clears what the form no longer shows, rather than leaving the old
      // model's tags behind on a row that no longer displays them.
      const stdv = state.model === 'STDV'
      const mm = state.model === 'MM'
      const tagged = stdv || mm
      const beMoved = tagged && fields.be_moved

      await upsertTrade({
        id: full.id,
        num: full.num ?? (await nextTradeNum()),
        date,
        type: $('#f-type').value,
        status: $('#f-status').value,
        pnl: parseFloat($('#f-pnl').value) || 0,
        risk: parseFloat($('#f-risk').value) || 0,
        rr: parseFloat($('#f-rr').value) || 0,
        thesis: $('#f-thesis').value.trim(),
        hindsight: $('#f-hindsight').value.trim(),
        image: state.image,
        model: state.model,
        setup_type: stdv ? state.setup_type : null,
        mm_setup: mm ? state.mm_setup : null,
        band_touched: stdv ? [...state.band_touched] : [],
        away_stack: stdv && fields.away_stack,
        stack_ratio: stdv ? numOrNull(fields.stack_ratio) : null,
        entry_delay_sec: stdv ? numOrNull(fields.entry_delay_sec) : null,
        planned_stop: tagged ? numOrNull(fields.planned_stop) : null,
        entry_price: mm ? numOrNull(fields.entry_price) : null,
        actual_exit: tagged ? numOrNull(fields.actual_exit) : null,
        target: tagged ? [...state.target] : [],
        be_moved: beMoved,
        // FlowJournal drops the reason when BE wasn't moved; keep that.
        be_reason: beMoved ? state.be_reason : null,
        regime: tagged ? state.regime : null,
        gamma_regime: tagged ? state.gamma_regime : null,
        major_regime: stdv ? (state.major_regime == null ? null : state.major_regime === 'yes') : null,
        day_type: stdv ? fields.day_type || null : null,
        news_window: stdv && fields.news_window,
        rule_broken: tagged ? [...state.rule_broken] : [],
        account_id: $('#f-account').value || null,
      })
      // Only remembered once the save succeeded, and only when an account was
      // actually picked — clearing the field is not a new default.
      if ($('#f-account').value) rememberLastUsedAccount($('#f-account').value)
      close()
      onSaved?.()
    } catch (e) {
      err.textContent = e.message || 'Save failed'
      button.disabled = false
    }
  }

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) return close()

    const seg = e.target.closest('.seg[data-model]')
    if (seg) return setModel(seg.dataset.model)

    const p = e.target.closest('.pill')
    if (p) {
      if (p.dataset.dropTarget) {
        state.target.delete(p.dataset.dropTarget)
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
      state.image = null
      renderUpload()
    } else if (act === 'calc-rr') {
      const pnl = parseFloat($('#f-pnl').value)
      const risk = parseFloat($('#f-risk').value)
      if (!Number.isNaN(pnl) && risk > 0) $('#f-rr').value = (Math.abs(pnl) / risk).toFixed(2)
      else err.textContent = 'Enter P&L and a non-zero risk first'
    }
  })

  $('#f-image').addEventListener('change', (e) => useImageFile(e.target.files[0]))
  document.addEventListener('keydown', onKey)
  document.addEventListener('paste', onPaste)

  renderPanel()
  renderUpload()
  $('#f-date').focus()
}
