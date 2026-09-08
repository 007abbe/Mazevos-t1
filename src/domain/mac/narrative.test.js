import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MACRO_HEADING, macroHeadline, macroParagraph } from './narrative.js'

/** The spec's worked-example snapshot, trimmed to what the paragraph reads. */
const snapshot = (overrides = {}) => ({
  date: '2026-09-08',
  version: 'mac-0.1',
  l1: {
    quadrant: 'stagflation_adjacent',
    bias_raw: -3,
    conviction: 'medium',
    conviction_agreeing: 3,
    regime_age_days: 8,
    regime: { label: 'leaning_bear', since: '2026-08-27', pending: null, pending_streak: 0 },
    bar: {
      bull_pct: 38,
      bear_pct: 62,
      label: 'leaning_bear',
      label_text: 'leaning bear',
      sentence:
        '38% bull / 62% bear — leaning bear. Shorts may have a tailwind; vol regime elevated, size capped.',
      history_10: [44, 42, 40, 38],
    },
    headwinds: ['Core inflation re-accelerating', '2Y +27bps over 20d'],
    tailwinds: [],
    watch: ['watch: inflation input on 2026-09-11 — core CPI MoM ≤ 0.2 twice → 0'],
    ...overrides.l1,
  },
  l2: {
    vol_regime: 'elevated',
    day_type: 'normal',
    horizon_sessions: 3,
    horizon_ends: '2026-07-31',
    horizon_truncated: true,
    events_next_5: [],
    no_trade_windows: [],
    size_cap: 0.75,
    spm_allowed: true,
    mm_preferred: true,
    ...overrides.l2,
  },
  data_health: { missing: [], stale: [], carried: [], ...overrides.data_health },
})

test('the paragraph leads with the bar sentence, verbatim', () => {
  const lines = macroParagraph(snapshot()).split('\n')

  assert.equal(lines[0], `${MACRO_HEADING} (mac-0.1 · 2026-09-08)`)
  assert.equal(lines[1], snapshot().l1.bar.sentence)
})

test('the context line carries quadrant, agreement and age', () => {
  const text = macroParagraph(snapshot())

  assert.match(text, /Stagflation-adjacent · medium conviction \(3\/6 factors agree\) · held 8 sessions\./)
})

test('a lean published today says so rather than claiming an age', () => {
  const text = macroParagraph(snapshot({ l1: { ...snapshot().l1, regime_age_days: 0 } }))
  assert.match(text, /new today/)
})

test('one session is singular', () => {
  const text = macroParagraph(snapshot({ l1: { ...snapshot().l1, regime_age_days: 1 } }))
  assert.match(text, /held 1 session\./)
})

test('a pending label is disclosed with its progress', () => {
  const text = macroParagraph(
    snapshot({
      l1: {
        ...snapshot().l1,
        regime: { label: 'neutral', since: '2026-08-27', pending: 'bear', pending_streak: 2 },
      },
    })
  )

  assert.match(text, /bear pending \(2\/3\)/)
})

test('headwinds and tailwinds are separate lists and empty ones are omitted', () => {
  const text = macroParagraph(snapshot())

  assert.match(text, /Headwinds:\n {2}- Core inflation re-accelerating\n {2}- 2Y \+27bps over 20d/)
  assert.doesNotMatch(text, /Tailwinds/, 'an empty list is absent, not printed as "none"')
})

test('both lists appear when both have entries', () => {
  const text = macroParagraph(
    snapshot({ l1: { ...snapshot().l1, tailwinds: ['Net liquidity rising $80B over 4w'] } })
  )

  assert.match(text, /Headwinds:/)
  assert.match(text, /Tailwinds:\n {2}- Net liquidity rising/)
})

test('the watch list is rendered when present and dropped when empty', () => {
  assert.match(macroParagraph(snapshot()), /Watch:\n {2}- watch: inflation input on 2026-09-11/)
  assert.doesNotMatch(macroParagraph(snapshot({ l1: { ...snapshot().l1, watch: [] } })), /Watch:/)
})

test('the sizing line states the cap, and is absent on a calm normal day', () => {
  assert.match(macroParagraph(snapshot()), /vol elevated — size cap 75%, MM preferred\./)

  const calm = macroParagraph(
    snapshot({
      l2: {
        vol_regime: 'calm',
        size_cap: 1,
        spm_allowed: true,
        mm_preferred: false,
        day_type: 'normal',
      },
    })
  )
  assert.doesNotMatch(calm, /— size cap/)
})

test('a hostile regime says SPM is disabled', () => {
  const text = macroParagraph(
    snapshot({ l2: { vol_regime: 'hostile', size_cap: 0.5, spm_allowed: false, mm_preferred: true } })
  )

  assert.match(text, /size cap 50%, SPM disabled, MM preferred/)
})

test('the sizing line names an event day even when vol is calm', () => {
  const text = macroParagraph(
    snapshot({
      l2: {
        vol_regime: 'calm',
        day_type: 'tier1_event',
        size_cap: 0.5,
        spm_allowed: false,
        mm_preferred: false,
      },
    })
  )

  assert.match(text, /Tier 1 event day — size cap 50%, SPM disabled\./)
  assert.doesNotMatch(text, /vol calm/, 'calm vol is not worth a mention on its own')
})

test('no-trade windows are listed with the release that causes them', () => {
  const text = macroParagraph(
    snapshot({
      l2: {
        ...snapshot().l2,
        no_trade_windows: [{ from: '08:30', to: '08:35', why: 'CPI m/m — release' }],
      },
    })
  )

  assert.match(text, /No-trade windows \(ET\):\n {2}- 08:30–08:35 — CPI m\/m — release/)
})

test('a truncated horizon says so rather than reading as a quiet week', () => {
  const text = macroParagraph(
    snapshot({
      l2: {
        ...snapshot().l2,
        events_next_5: [],
        horizon_sessions: 2,
        horizon_ends: '2026-09-11',
        horizon_truncated: true,
      },
    })
  )

  assert.match(text, /Scheduled: nothing in the next 2 sessions\./)
  assert.match(text, /calendar ends 2026-09-11 — the feed only carries this week/)
})

test('a full five-session horizon carries no caveat', () => {
  const text = macroParagraph(
    snapshot({
      l2: {
        ...snapshot().l2,
        events_next_5: [
          {
            date: '2026-09-11',
            timeLabel: '08:30 ET / 14:30 CET',
            title: 'CPI m/m',
            tier: 1,
            forecast: '0.3%',
          },
        ],
        horizon_sessions: 5,
        horizon_ends: '2026-09-14',
        horizon_truncated: false,
      },
    })
  )

  assert.match(text, /Scheduled \(5 sessions ahead\):/)
  assert.match(text, /2026-09-11 08:30 ET \/ 14:30 CET — CPI m\/m \[tier 1\] fcst 0\.3%/)
  assert.doesNotMatch(text, /only carries this week/)
})

test('a missing calendar is named in data health', () => {
  const text = macroParagraph(
    snapshot({ data_health: { missing: ['CALENDAR'], stale: [], carried: [] } })
  )

  assert.match(text, /missing the event calendar/)
})

test('a data-health warning appears whenever anything was missing, stale or carried', () => {
  const text = macroParagraph(
    snapshot({
      data_health: { missing: ['ISM_PMI'], stale: ['BAMLH0A0HYM2'], carried: ['credit'] },
    })
  )

  assert.match(text, /⚠ Data health — missing ISM PMI; stale HY OAS; carried forward: credit\./)
})

test('a clean run says nothing about data health', () => {
  assert.doesNotMatch(macroParagraph(snapshot()), /Data health/)
})

test('no snapshot means no section at all', () => {
  assert.equal(macroParagraph(null), null)
  assert.equal(macroParagraph(undefined), null)
  assert.equal(macroParagraph({}), null)
  assert.equal(macroParagraph({ l1: { bar: {} } }), null)
})

test('the paragraph never upgrades the lean into a probability', () => {
  const text = macroParagraph(snapshot())

  assert.doesNotMatch(text, /chance|probability|likely|odds|expect/i)
  assert.match(text, /may have a tailwind/)
})

test('macroHeadline is the one-line form', () => {
  assert.equal(macroHeadline(snapshot()), '38/62 — leaning bear')
  assert.equal(macroHeadline(null), null)
})

test('the size cap is disowned while mac is still being validated', () => {
  // A brief that prints "size cap 50%" with no qualifier is an instruction, and
  // following it contaminates the sample Phase 4 measures.
  const text = macroParagraph(snapshot())

  assert.match(text, /size cap 75%, MM preferred\. \(Logging phase — display only/)
  assert.match(text, /Do not size off this/)
})
