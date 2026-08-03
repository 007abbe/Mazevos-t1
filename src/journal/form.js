import {
  TYPES, STATUSES, SETUP_TYPES, BANDS, TARGETS, REGIMES, BE_REASONS, DAY_TYPES,
  RULES_BROKEN,
} from '../domain/trade-vocab.js'
import { upsertTrade, deleteTrade, getTrade, nextTradeNum } from './trades.js'
import { toDatetimeLocal, isValidTradeDate } from './mapping.js'
import { compressImage, dataUrlBytes, isImageFile } from './screenshots.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const numOrNull = (el) => {
  const v = parseFloat(el.value)
  return Number.isNaN(v) ? null : v
}


const pill = (key, value, label = value) =>
  `<button type="button" class="pill" data-key="${esc(key)}" data-val="${esc(value)}">${esc(label)}</button>`

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

function template(trade) {
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

        <div class="tags">
          <div class="tags-head">Model tags · STDV</div>

          <div class="tag-row">
            <div class="tag-group">
              <span class="tag-label">Setup</span>
              <div class="pill-row">${SETUP_TYPES.map((v) => pill('setup_type', v)).join('')}</div>
            </div>
            <div class="tag-group">
              <span class="tag-label">Band touched</span>
              <div class="pill-row">${inOrder(BANDS, BAND_ORDER).map((v) => pill('band_touched', v)).join('')}</div>
            </div>
            <div class="tag-group">
              <span class="tag-label">Target</span>
              <div class="pill-row">
                ${TARGETS.map((v) => pill('target', v)).join('')}
                <input type="text" id="f-target-custom" class="tag-input" placeholder="custom…">
              </div>
            </div>
            <div class="tag-group">
              <span class="tag-label">Regime</span>
              <div class="pill-row">${REGIMES.map((v) => pill('regime', v, cap(v))).join('')}</div>
            </div>
            <label class="tag-group">
              <span class="tag-label">Day type</span>
              <select class="tag-select" id="f-day-type"><option value="">—</option>${options(DAY_TYPES, trade.day_type)}</select>
            </label>
          </div>

          <div class="tag-row">
            <label class="tag-toggle"><input type="checkbox" id="f-away-stack"><span class="tswitch"></span>Away-stack</label>
            <label class="tag-group"><span class="tag-label">Stack ratio</span><input class="tag-input" type="number" id="f-stack-ratio" step="0.1" placeholder="3.0" value="${trade.stack_ratio ?? ''}"></label>
            <label class="tag-group"><span class="tag-label">Entry delay (s)</span><input class="tag-input" type="number" id="f-entry-delay" step="1" placeholder="sec" value="${trade.entry_delay_sec ?? ''}"></label>
            <label class="tag-group"><span class="tag-label">Planned stop</span><input class="tag-input" type="number" id="f-planned-stop" step="0.25" placeholder="price" value="${trade.planned_stop ?? ''}"></label>
            <label class="tag-group"><span class="tag-label">Actual exit</span><input class="tag-input" type="number" id="f-actual-exit" step="0.25" placeholder="price" value="${trade.actual_exit ?? ''}"></label>
          </div>

          <div class="tag-row">
            <label class="tag-toggle"><input type="checkbox" id="f-be-moved"><span class="tswitch"></span>BE moved</label>
            <div class="tag-group" id="grp-be-reason" hidden>
              <span class="tag-label">BE reason</span>
              <div class="pill-row">${inOrder(BE_REASONS, BE_REASON_ORDER).map((v) => pill('be_reason', v, cap(v))).join('')}</div>
            </div>
            <label class="tag-toggle"><input type="checkbox" id="f-news-window"><span class="tswitch"></span>News ±15 min</label>
          </div>

          <div class="tag-group">
            <span class="tag-label">Rules broken</span>
            <div class="pill-row">
              ${inOrder(RULES_BROKEN.map((r) => r.value), RULE_ORDER)
                .map((v) => `<button type="button" class="pill pill-red" data-multi="rule_broken" data-val="${esc(v)}">${esc(v)}</button>`)
                .join('')}
            </div>
          </div>
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
  const full = trade.id ? (await getTrade(trade.id)) ?? trade : trade

  const state = {
    setup_type: full.setup_type ?? null,
    band_touched: full.band_touched ?? null,
    target: TARGETS.includes(full.target) ? full.target : null,
    regime: full.regime ?? null,
    be_reason: full.be_reason ?? null,
    rule_broken: new Set(full.rule_broken ?? []),
    image: full.image ?? null,
  }

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.innerHTML = template(full)
  document.body.append(overlay)

  const $ = (sel) => overlay.querySelector(sel)
  const err = $('#form-err')

  // Values the template can't set declaratively.
  $('#f-away-stack').checked = !!full.away_stack
  $('#f-be-moved').checked = !!full.be_moved
  $('#f-news-window').checked = !!full.news_window
  if (full.target && !TARGETS.includes(full.target)) $('#f-target-custom').value = full.target

  function syncPills() {
    for (const el of overlay.querySelectorAll('.pill[data-key]')) {
      el.classList.toggle('on', state[el.dataset.key] === el.dataset.val)
    }
    for (const el of overlay.querySelectorAll('.pill[data-multi]')) {
      el.classList.toggle('on', state.rule_broken.has(el.dataset.val))
    }
    $('#grp-be-reason').hidden = !$('#f-be-moved').checked
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

      const beMoved = $('#f-be-moved').checked
      const customTarget = $('#f-target-custom').value.trim()

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
        setup_type: state.setup_type,
        band_touched: state.band_touched,
        away_stack: $('#f-away-stack').checked,
        stack_ratio: numOrNull($('#f-stack-ratio')),
        entry_delay_sec: numOrNull($('#f-entry-delay')),
        planned_stop: numOrNull($('#f-planned-stop')),
        actual_exit: numOrNull($('#f-actual-exit')),
        target: customTarget || state.target,
        be_moved: beMoved,
        // FlowJournal drops the reason when BE wasn't moved; keep that.
        be_reason: beMoved ? state.be_reason : null,
        regime: state.regime,
        day_type: $('#f-day-type').value || null,
        news_window: $('#f-news-window').checked,
        rule_broken: [...state.rule_broken],
      })
      close()
      onSaved?.()
    } catch (e) {
      err.textContent = e.message || 'Save failed'
      button.disabled = false
    }
  }

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) return close()

    const p = e.target.closest('.pill')
    if (p) {
      if (p.dataset.multi) {
        state.rule_broken.has(p.dataset.val)
          ? state.rule_broken.delete(p.dataset.val)
          : state.rule_broken.add(p.dataset.val)
      } else {
        // Clicking the selected pill again clears it, as in FlowJournal.
        state[p.dataset.key] = state[p.dataset.key] === p.dataset.val ? null : p.dataset.val
        if (p.dataset.key === 'target') $('#f-target-custom').value = ''
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

  // A custom target and a target pill are mutually exclusive.
  $('#f-target-custom').addEventListener('input', (e) => {
    if (e.target.value) {
      state.target = null
      syncPills()
    }
  })
  $('#f-be-moved').addEventListener('change', syncPills)
  $('#f-image').addEventListener('change', (e) => useImageFile(e.target.files[0]))
  document.addEventListener('keydown', onKey)
  document.addEventListener('paste', onPaste)

  syncPills()
  renderUpload()
  $('#f-date').focus()
}
