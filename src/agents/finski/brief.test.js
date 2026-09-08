import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBriefInputs,
  formatBrief,
  generateBrief,
  toFunctionPayload,
  toStoredData,
} from './brief.js'

/** 08:00 ET on a summer weekday. */
const NOW = Date.parse('2026-07-29T08:00:00-04:00')

const CALENDAR = [
  {
    title: 'CPI m/m',
    country: 'USD',
    date: '2026-07-29T08:30:00-04:00',
    impact: 'High',
    forecast: '0.3%',
    previous: '0.2%',
  },
  {
    title: 'German ifo',
    country: 'EUR',
    date: '2026-07-29T04:00:00-04:00',
    impact: 'High',
    forecast: '',
    previous: '',
  },
]

const QUIET_VIX = { now: 15, prev: 15 }
const NO_LEVELS = { onHigh: null, onLow: null, priorClose: null }

const inputs = (overrides = {}) =>
  buildBriefInputs({
    calendar: CALENDAR,
    vix: QUIET_VIX,
    levels: NO_LEVELS,
    now: NOW,
    ...overrides,
  })

test('buildBriefInputs runs the calendar through the rules', () => {
  const result = inputs()

  assert.deepEqual(
    result.events.map((e) => e.title),
    ['CPI m/m'],
    'non-USD events are filtered out before the rules see them'
  )
  assert.equal(result.risk.level, 'HIGH')
  assert.deepEqual(result.risk.triggered, [
    'CPI m/m not yet released (08:30 ET / 14:30 CET)',
  ])
})

test('buildBriefInputs feeds tagged trades into the regime rule', () => {
  const result = inputs({
    calendar: [],
    trades: [{ date: '2026-07-28T15:00', day_type: 'Trend Day', regime: 'trend' }],
  })

  assert.equal(result.risk.level, 'ELEVATED')
  assert.deepEqual(result.yesterday, {
    date: '2026-07-28',
    day_type: 'Trend Day',
    regime: 'trend',
  })
})

test('the function payload carries labelled times and no raw instants', () => {
  const payload = toFunctionPayload(inputs())

  assert.equal(payload.level, 'HIGH')
  assert.deepEqual(payload.events, [
    {
      title: 'CPI m/m',
      impact: 'High',
      timeLabel: '08:30 ET / 14:30 CET',
      forecast: '0.3%',
      previous: '0.2%',
    },
  ])
  assert.ok(!('dt' in payload.events[0]), 'the function never compares times')
})

test('the stored row keeps both zones for reading a brief back later', () => {
  const stored = toStoredData(inputs())

  assert.deepEqual(stored.events[0], {
    title: 'CPI m/m',
    impact: 'High',
    timeET: '08:30',
    timeCET: '14:30',
    timeLabel: '08:30 ET / 14:30 CET',
    forecast: '0.3%',
    previous: '0.2%',
  })
  assert.deepEqual(stored.vix, QUIET_VIX)
})

test('formatBrief dates the brief in New York time', () => {
  const risk = { level: 'ELEVATED', triggered: ['VIX 24 in 20–28 band'] }
  const brief = formatBrief({ risk, prose: 'REGIME\nCalm.', now: NOW })

  assert.equal(
    brief,
    'FINSKI BRIEF — 2026-07-29\n' +
      'MODEL-RISK: ELEVATED\n' +
      'Triggered: VIX 24 in 20–28 band\n\n' +
      'REGIME\nCalm.'
  )
})

test('formatBrief still dates to today when written late in the CET evening', () => {
  // 23:00 CET on the 29th is already the 30th in UTC.
  const cetEvening = Date.parse('2026-07-29T23:00:00+02:00')
  const brief = formatBrief({
    risk: { level: 'LOW', triggered: [] },
    prose: 'REGIME\nCalm.',
    now: cetEvening,
  })

  assert.match(brief, /FINSKI BRIEF — 2026-07-29/)
})

test('formatBrief omits the Triggered line when nothing fired', () => {
  const brief = formatBrief({
    risk: { level: 'LOW', triggered: [] },
    prose: 'REGIME\nCalm.',
    now: NOW,
  })

  assert.equal(brief, 'FINSKI BRIEF — 2026-07-29\nMODEL-RISK: LOW\n\nREGIME\nCalm.')
})

// --- generateBrief --------------------------------------------------------

const deps = (overrides = {}) => {
  const saved = []
  const requested = []
  return {
    saved,
    requested,
    deps: {
      fetchCalendar: async () => ({ events: CALENDAR, fromCache: false }),
      requestBrief: async (payload) => {
        requested.push(payload)
        return { prose: 'REGIME\nCalm.' }
      },
      saveBrief: async (row) => {
        saved.push(row)
      },
      ...overrides,
    },
  }
}

test('generateBrief runs calendar → rules → prose → save', async () => {
  const { deps: d, saved, requested } = deps()

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, now: NOW },
    d
  )

  assert.equal(result.risk.level, 'HIGH')
  assert.match(result.brief, /^FINSKI BRIEF — 2026-07-29\nMODEL-RISK: HIGH/)
  assert.equal(result.saved, true)
  assert.equal(requested.length, 1)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].risk.level, 'HIGH')
  assert.equal(saved[0].brief, result.brief)
})

test('generateBrief reports progress in order', async () => {
  const steps = []
  const { deps: d } = deps()

  await generateBrief({ vix: QUIET_VIX, levels: NO_LEVELS, now: NOW }, {
    ...d,
    onProgress: (step) => steps.push(step),
  })

  assert.deepEqual(steps, ['Fetching calendar…', 'Writing brief…'])
})

test('generateBrief surfaces a stale calendar without failing', async () => {
  const { deps: d } = deps({
    fetchCalendar: async () => ({ events: CALENDAR, fromCache: true, stale: true }),
  })

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, now: NOW },
    d
  )

  assert.equal(result.stale, true)
  assert.equal(result.fromCache, true)
  assert.ok(result.brief, 'a stale calendar still produces a brief')
})

test('a failed save does not lose the brief', async () => {
  const { deps: d } = deps({
    saveBrief: async () => {
      throw new Error('insert failed')
    },
  })

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, now: NOW },
    d
  )

  assert.equal(result.saved, false)
  assert.equal(result.saveError.message, 'insert failed')
  assert.match(result.brief, /MODEL-RISK: HIGH/, 'the text is still returned')
})

test('a failed calendar fetch aborts before spending a request', async () => {
  const { deps: d, requested } = deps({
    fetchCalendar: async () => {
      throw new Error('Calendar unavailable')
    },
  })

  await assert.rejects(
    generateBrief({ vix: QUIET_VIX, levels: NO_LEVELS, now: NOW }, d),
    /Calendar unavailable/
  )
  assert.equal(requested.length, 0)
})

test('a truncated response is flagged through to the caller', async () => {
  const { deps: d } = deps({
    requestBrief: async () => ({ prose: 'REGIME\nCal', truncated: true }),
  })

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, now: NOW },
    d
  )

  assert.equal(result.truncated, true)
})

/* ------------------------------------------------------ mac integration ---- */

/**
 * A mac snapshot, trimmed to what the brief reads. Deliberately directional:
 * the point of these tests is that a bull/bear read reaches the brief without
 * ever reaching the model.
 */
const MACRO = {
  date: '2026-07-29',
  version: 'mac-0.1',
  l1: {
    quadrant: 'stagflation_adjacent',
    bias_raw: -3,
    conviction: 'medium',
    conviction_agreeing: 3,
    regime_age_days: 8,
    regime: { label: 'leaning_bear', since: '2026-07-21', pending: null, pending_streak: 0 },
    bar: {
      bull_pct: 38,
      bear_pct: 62,
      label: 'leaning_bear',
      label_text: 'leaning bear',
      sentence:
        '38% bull / 62% bear — leaning bear. Shorts may have a tailwind; vol regime elevated, size capped.',
      history_10: [44, 42, 40, 38],
    },
    headwinds: ['Core inflation re-accelerating'],
    tailwinds: [],
    watch: [],
  },
  l2: { vol_regime: 'elevated', size_cap: 0.75, spm_allowed: true, mm_preferred: true },
  data_health: { missing: [], stale: [], carried: [] },
}

test('formatBrief is byte-identical to the pre-mac output with no snapshot', () => {
  const risk = { level: 'LOW', triggered: [] }

  assert.equal(
    formatBrief({ risk, prose: 'REGIME\nCalm.', now: NOW }),
    formatBrief({ risk, prose: 'REGIME\nCalm.', now: NOW, macro: null })
  )
  assert.equal(
    formatBrief({ risk, prose: 'REGIME\nCalm.', now: NOW }),
    'FINSKI BRIEF — 2026-07-29\nMODEL-RISK: LOW\n\nREGIME\nCalm.'
  )
})

test('formatBrief splices MACRO between the header and the model prose', () => {
  const brief = formatBrief({
    risk: { level: 'LOW', triggered: [] },
    prose: 'REGIME\nCalm.',
    now: NOW,
    macro: MACRO,
  })

  const header = brief.indexOf('MODEL-RISK: LOW')
  const macro = brief.indexOf('MACRO (mac-0.1')
  const prose = brief.indexOf('REGIME\nCalm.')

  assert.ok(header < macro && macro < prose, 'header, then macro, then prose')
  assert.match(brief, /38% bull \/ 62% bear/)
})

test('the macro snapshot never reaches the model', () => {
  const payload = toFunctionPayload({ ...inputs(), macro: MACRO })

  assert.equal('macro' in payload, false)
  assert.doesNotMatch(JSON.stringify(payload), /bull|bear|leaning|macro/i)
})

test('the stored row keeps the lean the brief was written under', () => {
  const stored = toStoredData({ ...inputs(), macro: MACRO })

  assert.deepEqual(stored.macro, {
    date: '2026-07-29',
    version: 'mac-0.1',
    bull_pct: 38,
    label: 'leaning_bear',
    bias_raw: -3,
    conviction: 'medium',
    vol_regime: 'elevated',
  })
  assert.equal(toStoredData(inputs()).macro, null)
})

test('generateBrief carries the snapshot into the brief, the row and the result', async () => {
  const { deps: d, saved, requested } = deps()

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, macro: MACRO, now: NOW },
    d
  )

  assert.match(result.brief, /MACRO \(mac-0\.1 · 2026-07-29\)/)
  assert.equal(result.macro, MACRO)
  assert.equal(saved[0].data.macro.bull_pct, 38)
  assert.equal('macro' in requested[0], false, 'still nothing directional in the prompt payload')
})

test('a brief generated without mac is unchanged and reports the absence', async () => {
  const { deps: d, saved } = deps()

  const result = await generateBrief({ vix: QUIET_VIX, levels: NO_LEVELS, now: NOW }, d)

  assert.equal(result.macro, null)
  assert.doesNotMatch(result.brief, /MACRO/)
  assert.equal(saved[0].data.macro, null)
})
