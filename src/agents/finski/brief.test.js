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
