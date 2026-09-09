import { esc, explainFailure } from '../../../lib/ui-text.js'
import { FACTOR_KEYS, QUADRANT_LABELS } from '../../../domain/mac/compose.js'
import { SERIES } from '../../../domain/mac/factors.js'
import { macroParagraph } from '../../../domain/mac/narrative.js'
import { GATING_ENABLED, LOGGING_NOTICE } from '../../../domain/mac/validation.js'
import { harvestHealth } from '../../../domain/mac/ff-actuals.js'
import { fetchIsmActuals } from './actuals.js'
import { etDate } from '../../../domain/et-session.js'
import { fetchCalendar } from '../../finski/calendar.js'
import { fetchSeries } from './client.js'
import { listSnapshots, priorSnapshot, saveSnapshot, snapshotFor } from './snapshots.js'
import { runMac } from './run.js'

/**
 * mac — the systematic macro reader.
 *
 * The card leads with the bar because that is the output; the factor chips
 * underneath exist so the bar is never a black box. Every chip carries its own
 * mechanism and flip condition, which is the difference between a number that
 * wobbles and a state you can argue with.
 */

const explain = (error) => explainFailure(error, { prefix: 'mac failed' })

const FACTOR_TITLES = {
  growth: 'Growth',
  inflation: 'Inflation',
  rates: 'Rates',
  liquidity: 'Liquidity',
  credit: 'Credit',
  dollar: 'Dollar',
}

const num = (value, digits = 1) =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits)

/** A factor state as a signed chip, e.g. `+1`, `0`, `−2`. */
const stateChip = (state) =>
  state === 0 ? '0' : `${state > 0 ? '+' : '−'}${Math.abs(state)}`

const toneOf = (state) => (state > 0 ? 'bull' : state < 0 ? 'bear' : 'flat')

/**
 * The bar itself: bear left, bull right, with the split marked.
 *
 * Two bars rather than one with a marker, because the number that matters is
 * the *ratio* and a single filled bar reads as a gauge — as progress toward
 * something — which is precisely the probability reading the spec forbids until
 * phase 4 calibrates it.
 */
const barBlock = (snapshot) => {
  const { bar, regime_age_days } = snapshot.l1
  const history = bar.history_10 ?? []

  return `
    <div class="mac-bar-card">
      <div class="mac-bar" role="img"
           aria-label="${bar.bear_pct} percent bear, ${bar.bull_pct} percent bull">
        <div class="mac-bar-bear" style="width:${bar.bear_pct}%">
          <span>${bar.bear_pct}% bear</span>
        </div>
        <div class="mac-bar-bull" style="width:${bar.bull_pct}%">
          <span>${bar.bull_pct}% bull</span>
        </div>
      </div>
      <p class="mac-sentence">${esc(bar.sentence)}</p>
      <div class="mac-bar-meta">
        <span class="mac-tag mac-tag-${esc(toneOf(snapshot.l1.bias_raw))}">
          bias ${snapshot.l1.bias_raw >= 0 ? '+' : '−'}${Math.abs(snapshot.l1.bias_raw)}
        </span>
        <span class="mac-tag">${esc(snapshot.l1.conviction)} conviction
          (${snapshot.l1.conviction_agreeing}/6)</span>
        ${
          snapshot.l1.quadrant
            ? `<span class="mac-tag">${esc(QUADRANT_LABELS[snapshot.l1.quadrant])}</span>`
            : ''
        }
        <span class="mac-tag">${
          regime_age_days === 0 ? 'new today' : `held ${regime_age_days}d`
        }</span>
        <span class="mac-tag mac-tag-vol-${esc(snapshot.l2.vol_regime)}">
          vol ${esc(snapshot.l2.vol_regime)} · cap ${Math.round(snapshot.l2.size_cap * 100)}%
        </span>
      </div>
      ${sparkline(history)}
    </div>
  `
}

/**
 * Ten sessions of `bull_pct`, drawn against a fixed 0–100 axis.
 *
 * Fixed, not auto-scaled to the data: a lean that has sat between 44 and 46 all
 * fortnight would otherwise render as a dramatic zigzag, which is the opposite
 * of what persistence is supposed to communicate. The 50 line is drawn so the
 * side of neutral is readable at a glance.
 */
function sparkline(history) {
  if (history.length < 2) {
    return `<p class="muted mac-spark-empty">Sparkline builds from the second session.</p>`
  }

  const width = 220
  const height = 40
  const step = width / (history.length - 1)
  const y = (pct) => height - (pct / 100) * height

  const points = history.map((pct, i) => `${(i * step).toFixed(1)},${y(pct).toFixed(1)}`).join(' ')
  const lastTone = toneOf(history[history.length - 1] - 50)

  return `
    <svg class="mac-spark mac-spark-${lastTone}" viewBox="0 0 ${width} ${height}"
         preserveAspectRatio="none" aria-label="Ten-session bull percentage">
      <line x1="0" y1="${y(50)}" x2="${width}" y2="${y(50)}" class="mac-spark-mid"/>
      <polyline points="${points}"/>
    </svg>
    <p class="muted mac-spark-caption">${history.length}-session bull %, 0–100 axis</p>
  `
}

/** One factor, with its mechanism and what would change it. */
const factorCard = (key, factor) => `
  <details class="mac-factor mac-factor-${esc(toneOf(factor.state))}"
           ${factor.carried ? 'data-carried="1"' : ''}>
    <summary>
      <span class="mac-factor-name">${esc(FACTOR_TITLES[key])}</span>
      <span class="mac-factor-state">${esc(stateChip(factor.state))}</span>
      ${factor.carried ? '<span class="mac-factor-carried">carried</span>' : ''}
    </summary>
    <p class="mac-factor-note">${esc(factor.note)}</p>
    <dl class="mac-factor-inputs">
      ${Object.entries(factor.inputs)
        .map(
          ([name, value]) =>
            `<div><dt>${esc(name)}</dt><dd class="mono">${esc(
              value == null ? '—' : String(value)
            )}</dd></div>`
        )
        .join('')}
    </dl>
    <p class="mac-factor-flip">
      <strong>Flips if:</strong> ${esc(factor.flip.what)}
      ${factor.flip.when ? `<span class="muted">(next input ${esc(factor.flip.when)})</span>` : ''}
    </p>
  </details>
`

const windList = (title, items, tone) =>
  items.length
    ? `<div class="mac-winds mac-winds-${tone}">
         <h4>${esc(title)}</h4>
         <ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
       </div>`
    : ''

/**
 * The live-tells reference card.
 *
 * Parked from the MotiveWave side but shown anyway, because the point of these
 * three rules is to be in front of you during the session. Checking them is
 * manual until a panel exists; the baselines they are measured against come
 * from the snapshot.
 */
const liveTells = (snapshot) => {
  const b = snapshot.l3_baselines ?? {}

  return `
    <div class="mac-tells">
      <h4>Live tells — checked by eye</h4>
      <p class="muted">
        Any one lit means macro is in control of the tape: trust MM over SPM for the
        next 30 minutes, and do not fade the current move.
      </p>
      <ul>
        <li><strong>2Y</strong> moves ≥ 5bps in 30 min <span class="muted">— baseline ${num(b.dgs2, 2)}</span></li>
        <li><strong>DXY</strong> ≥ 0.3% from baseline <span class="muted">— baseline ${num(b.dxy, 2)}</span></li>
        <li><strong>USD/JPY</strong> ≤ −0.8% on a red tape <span class="muted">— baseline ${num(b.usdjpy, 2)}</span></li>
      </ul>
    </div>
  `
}

/** Missing, stale and carried inputs, named rather than hinted at. */
const healthBlock = (snapshot, failed) => {
  const { missing = [], stale = [], carried = [] } = snapshot.data_health ?? {}
  const label = (id) => SERIES[id]?.label ?? (id === 'ISM_PMI' ? 'ISM PMI' : id)

  const rows = [
    missing.length ? `Missing: ${missing.map(label).join(', ')}` : '',
    stale.length ? `Stale: ${stale.map(label).join(', ')}` : '',
    carried.length ? `Carried forward: ${carried.join(', ')}` : '',
    // Merged, so a snapshot loaded from storage still explains itself — the
    // daily run happens on app load with nobody watching the status line.
    ...Object.entries({
      ...(snapshot.data_health?.fetch_errors ?? {}),
      ...(failed ?? {}),
    }).map(([id, why]) => `${label(id)} — ${why}`),
  ].filter(Boolean)

  if (rows.length === 0) {
    return `<p class="mac-health mac-health-ok">✓ All inputs fresh.</p>`
  }

  return `
    <div class="mac-health mac-health-warn">
      <strong>⚠ Data health</strong>
      <ul>${rows.map((row) => `<li>${esc(row)}</li>`).join('')}</ul>
    </div>
  `
}

const DAY_TYPES = {
  tier1_event: 'Tier 1 event day',
  tier2_event: 'Tier 2 event day',
  auction_day: 'Auction day',
  quarter_end: 'Quarter end',
  normal: 'Normal day',
}

/**
 * The tactical block: what kind of day this is and what it costs.
 *
 * The horizon note is the load-bearing part. ForexFactory publishes only the
 * current week, so by Thursday this list covers two sessions rather than five —
 * and a short list that does not say it is short is indistinguishable from a
 * genuinely quiet week.
 */
const dayBlock = (snapshot) => {
  const { l2 } = snapshot
  if (!l2.day_type) {
    return `<p class="mac-health mac-health-warn">
      ⚠ ${
        l2.calendar_stale
          ? `Calendar is stale — it ends ${esc(l2.feed_ends ?? 'before today')} and does not
             reach today, so the day cannot be typed. Refresh
             <span class="mono">public/data/ff_calendar.json</span> (the "Fetch FF calendar"
             Action, or <span class="mono">git pull</span> locally).`
          : 'No calendar — the day is untyped.'
      }
      Size cap is vol-only until it is fixed.
    </p>`
  }

  const flags = Object.entries(l2.flags ?? {})
    .filter(([, on]) => on)
    .map(([name]) => `<span class="mac-tag">${esc(name.replace('_', ' '))}</span>`)
    .join('')

  const windows = (l2.no_trade_windows ?? [])
    .map((w) => `<li><span class="mono">${esc(w.from)}–${esc(w.to)} ET</span> — ${esc(w.why)}</li>`)
    .join('')

  const events = (l2.events_next_5 ?? [])
    .map(
      (e) => `<li>
        <span class="mono">${esc(e.date)}</span>
        <span class="mono">${esc(e.timeLabel)}</span>
        ${esc(e.title)}
        ${e.tier ? `<span class="mac-tag mac-tag-tier${e.tier}">tier ${e.tier}</span>` : ''}
        ${e.forecast ? `<span class="muted">fcst ${esc(e.forecast)}</span>` : ''}
      </li>`
    )
    .join('')

  return `
    <div class="mac-day">
      <div class="mac-day-head">
        <span class="mac-tag mac-tag-day">${esc(DAY_TYPES[l2.day_type] ?? l2.day_type)}</span>
        <span class="mac-tag">cap ${Math.round(l2.size_cap * 100)}%</span>
        <span class="mac-tag ${l2.spm_allowed ? '' : 'mac-tag-bear'}">
          SPM ${l2.spm_allowed ? 'allowed' : 'disabled'}
        </span>
        ${l2.mm_preferred ? '<span class="mac-tag">MM preferred</span>' : ''}
        ${flags}
      </div>

      ${windows ? `<h4>No-trade windows</h4><ul class="mac-day-list">${windows}</ul>` : ''}

      <h4>Next ${l2.horizon_sessions} session${l2.horizon_sessions === 1 ? '' : 's'}</h4>
      ${events ? `<ul class="mac-day-list">${events}</ul>` : '<p class="muted">Nothing scheduled.</p>'}
      ${
        l2.horizon_truncated
          ? `<p class="mac-horizon">⚠ Calendar ends ${esc(l2.horizon_ends ?? '—')}. ForexFactory
             publishes only the current week, so anything past it is unchecked — not clear.</p>`
          : ''
      }
    </div>
  `
}

/**
 * The one line that keeps the validation honest.
 *
 * mac renders a size cap. During the logging window that cap must not be acted
 * on — sizing off it makes hostile sessions systematically smaller and more
 * selective, and Phase 4 would then be measuring compliance with mac rather
 * than the regime. Saying so on the card is cheaper than discovering it in the
 * report six months from now.
 */
const loggingNotice = () =>
  GATING_ENABLED
    ? ''
    : `<p class="mac-logging">⚠ ${esc(LOGGING_NOTICE)}</p>`

/**
 * The environment card.
 *
 * Placed above the bar because it is the one part of mac with a mechanism
 * behind it rather than a fitted threshold, and because the bar's directional
 * claim did not survive validation. Two levels, the reasoning spelled out, and
 * no forecast.
 */
const environmentBlock = (snapshot) => {
  const env = snapshot.environment
  if (!env) return ''

  const tone =
    env.standing === 'headwind' ? 'bear' : env.standing === 'tailwind' ? 'bull' : 'flat'

  const real = env.rates.level == null ? '—' : `${env.rates.level.toFixed(2)}%`
  const change =
    env.liquidity.change_bn == null
      ? '—'
      : `${env.liquidity.change_bn >= 0 ? '+' : '−'}$${Math.abs(Math.round(env.liquidity.change_bn))}bn`
  const level =
    env.liquidity.level_bn == null ? '—' : `$${(env.liquidity.level_bn / 1000).toFixed(2)}tn`

  return `
    <div class="mac-env mac-env-${esc(tone)}">
      <div class="mac-env-head">
        <h3 class="agent-section">Environment</h3>
        <span class="mac-tag mac-tag-${esc(tone)}">${esc(env.standing_text)}</span>
      </div>
      <p class="mac-env-note">${esc(env.note)}</p>
      <dl class="mac-factor-inputs">
        <div><dt>10y real yield</dt><dd class="mono">${esc(real)} · ${esc(env.rates.stance ?? '—')}</dd></div>
        <div><dt>net liquidity</dt><dd class="mono">${esc(level)} · ${esc(env.liquidity.stance ?? '—')}</dd></div>
        <div><dt>13-week change</dt><dd class="mono">${esc(change)}</dd></div>
      </dl>
      <p class="muted">
        Context, not a signal. These are the two channels macro reaches a
        long-duration index through — the discount rate and the marginal bid. It
        says what the conditions are; it does not forecast the session.
        ${
          env.stale?.length
            ? `<strong>Held — ${esc(env.stale.join(', '))} stale.</strong>`
            : ''
        }
      </p>
    </div>
  `
}

const snapshotView = (snapshot, failed) => `
  ${environmentBlock(snapshot)}
  ${barBlock(snapshot)}
  ${loggingNotice()}
  ${healthBlock(snapshot, failed)}

  <h3 class="agent-section">Today</h3>
  ${dayBlock(snapshot)}

  <h3 class="agent-section">Factors</h3>
  <div class="mac-factors">
    ${FACTOR_KEYS.map((key) => factorCard(key, snapshot.l1.factors[key])).join('')}
  </div>

  <div class="mac-wind-lists">
    ${windList('Headwinds', snapshot.l1.headwinds ?? [], 'bear')}
    ${windList('Tailwinds', snapshot.l1.tailwinds ?? [], 'bull')}
    ${windList('Watch — next 5 sessions', snapshot.l1.watch ?? [], 'watch')}
  </div>

  ${liveTells(snapshot)}

  <h3 class="agent-section">Finski paragraph</h3>
  <p class="muted">
    Exactly what gets spliced into the pre-market brief. Written here, not by the model.
  </p>
  <pre class="brief">${esc(macroParagraph(snapshot) ?? '')}</pre>
`

const template = () => `
  <div class="agent-inputs">
    <div class="agent-actions">
      <button type="button" data-act="run">Compute snapshot</button>
      <span class="muted" data-role="status"></span>
    </div>

    <p class="muted" data-role="ism-hint">
      ISM is harvested automatically — leave both blank. Fill them in only to correct a
      harvested print or to enter one early.
    </p>
    <p class="err" data-role="error"></p>
  </div>

  <div data-role="snapshot"><p class="muted">Loading today's snapshot…</p></div>

  <h3 class="agent-section">
    History
    <button type="button" class="ghost" data-act="refresh">Refresh</button>
  </h3>
  <div data-role="history"><p class="muted">Loading…</p></div>

  <p class="mac-attribution muted">
    Macro series from <strong>FRED</strong>, Federal Reserve Bank of St. Louis. Economic
    calendar from ForexFactory. Neither is redistributed.
  </p>
`

const historyRow = (row) => {
  const bar = row.snapshot?.l1?.bar
  if (!bar) return ''

  return `
    <div class="mac-history-row">
      <span class="mono">${esc(row.date)}</span>
      <span class="mac-history-bar">
        <span class="mac-history-fill mac-history-${esc(toneOf(bar.bull_pct - 50))}"
              style="width:${bar.bull_pct}%"></span>
      </span>
      <span class="mono">${bar.bull_pct}/${bar.bear_pct}</span>
      <span class="mac-history-label">${esc(bar.label_text)}</span>
      <span class="muted">vol ${esc(row.snapshot?.l2?.vol_regime ?? '—')}</span>
    </div>
  `
}

/** Renders the mac panel into `el`. */
export function renderMac(el) {
  el.innerHTML = template()

  const $ = (role) => el.querySelector(`[data-role="${role}"]`)
  const button = el.querySelector('[data-act="run"]')

  const setStatus = (text) => {
    $('status').textContent = text
  }
  const setError = (text) => {
    $('error').textContent = text
  }

  async function loadHistory() {
    const target = $('history')
    try {
      const rows = await listSnapshots()
      target.innerHTML = rows.length
        ? rows.map(historyRow).join('')
        : '<p class="muted">No snapshots yet.</p>'
    } catch (err) {
      target.innerHTML = `<p class="err">Could not load history: ${esc(err.message)}</p>`
    }
  }

  /**
   * Says what the harvest has, so the box can be left alone.
   *
   * The box used to be pre-filled with the consensus and framed as a monthly
   * chore. It is neither now: the Action scrapes the real `actual` from
   * ForexFactory's calendar page within hours of the release, so the only thing
   * left to report is which print is in play — and, past the grace period,
   * whether the harvest has stopped working.
   *
   * A forecast is never offered as a value. That was the failure the manual
   * entry existed to prevent, and it would be a worse one now that nobody is
   * expected to be checking.
   */
  async function describeIsm() {
    const hint = $('ism-hint')

    const entries = await fetchIsmActuals()
    const health = harvestHealth(entries, etDate(Date.now()))

    if (health.stale) {
      hint.className = 'err'
      hint.textContent =
        `ISM harvest is behind — newest print on file is ` +
        `${health.latest ?? 'none'}, expected ${health.expected}. ` +
        `F1 is running on stale growth data: check the "Fetch FF calendar" ` +
        `Action, then fix public/data/ism_pmi.json if the scrape is broken.`
      return
    }

    const latest = entries.at(-1)
    hint.className = 'muted'
    hint.textContent = latest
      ? `ISM ${latest.value} for ${latest.date.slice(0, 7)}, harvested automatically.`
      : 'ISM harvest has not run yet — mac is falling back to the one-month-old ' +
        'figure from the weekly feed.'
  }

  /** Shows the stored snapshot for today, if one was already computed. */
  async function loadToday() {
    try {
      const snapshot = await snapshotFor(etDate(Date.now()))
      $('snapshot').innerHTML = snapshot
        ? snapshotView(snapshot, {})
        : `<p class="muted">No snapshot for today yet — hit Compute snapshot.</p>`
    } catch (err) {
      $('snapshot').innerHTML = `<p class="err">Could not load snapshot: ${esc(err.message)}</p>`
    }
  }

  async function run() {
    setError('')
    button.disabled = true
    button.textContent = 'Working…'

    try {
      const result = await runMac(
        { now: Date.now() },
        { fetchSeries, fetchCalendar, fetchIsmActuals, priorSnapshot, saveSnapshot, onProgress: setStatus }
      )

      $('snapshot').innerHTML = snapshotView(result.snapshot, result.failed)

      setStatus(
        [
          Object.keys(result.failed).length ? '⚠ some series failed to fetch' : '',
          result.calendarError ? '⚠ calendar unavailable — day untyped' : '',
          result.saved ? '' : '⚠ not saved — tomorrow restarts its counters',
        ]
          .filter(Boolean)
          .join(' · ')
      )

      if (!result.saved) setError(explain(result.saveError))
      else await loadHistory()
    } catch (err) {
      setStatus('')
      setError(explain(err))
    } finally {
      button.disabled = false
      button.textContent = 'Compute snapshot'
    }
  }

  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')?.dataset.act
    if (action === 'run') run()
    if (action === 'refresh') loadHistory()
  })

  loadToday()
  loadHistory()
  describeIsm()
}
