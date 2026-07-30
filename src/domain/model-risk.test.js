import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeModelRisk,
  yesterdayContext,
  PERSISTENT_DAY_TYPE,
  VIX_HIGH,
  VIX_ELEVATED_FLOOR,
} from './model-risk.js'
import { DAY_TYPES } from './trade-vocab.js'

/**
 * 08:00 ET on a summer weekday — pre-market, before the 09:30 open.
 * Session that day: open 13:30Z, noon 16:00Z.
 */
const NOW = Date.parse('2026-07-29T08:00:00-04:00')

const event = (title, impact, iso, timeLabel = '08:30 ET / 14:30 CET') => ({
  title,
  impact,
  dt: new Date(iso),
  timeLabel,
})

/** VIX values that trip nothing, so each test isolates one rule. */
const QUIET_VIX = { now: 15, prev: 15 }

const risk = (overrides = {}) =>
  computeModelRisk({ vix: QUIET_VIX, now: NOW, ...overrides })

test('LOW with a quiet tape and an empty calendar', () => {
  assert.deepEqual(risk(), { level: 'LOW', triggered: [] })
})

test('`now` is required — the rules never read the clock themselves', () => {
  assert.throws(() => computeModelRisk({ vix: QUIET_VIX }), TypeError)
})

// --- HIGH -----------------------------------------------------------------

test('FOMC decision day is HIGH regardless of when it lands', () => {
  const result = risk({
    events: [event('FOMC Statement', 'High', '2026-07-29T18:00:00Z', '20:00')],
  })
  assert.equal(result.level, 'HIGH')
  assert.deepEqual(result.triggered, ['FOMC decision day'])
})

test('an unreleased major print is HIGH', () => {
  const result = risk({
    events: [event('CPI m/m', 'High', '2026-07-29T12:30:00Z', '08:30 ET / 14:30 CET')],
  })
  assert.equal(result.level, 'HIGH')
  assert.deepEqual(result.triggered, [
    'CPI m/m not yet released (08:30 ET / 14:30 CET)',
  ])
})

test('a major print already released is not HIGH on that rule', () => {
  const result = risk({
    events: [event('CPI m/m', 'High', '2026-07-29T04:00:00Z', '06:00')],
  })
  assert.equal(result.level, 'LOW')
  assert.deepEqual(result.triggered, [])
})

test('a Medium-impact major print does not trip the unreleased rule', () => {
  const result = risk({
    events: [event('PPI m/m', 'Medium', '2026-07-29T12:30:00Z')],
  })
  assert.equal(result.level, 'LOW')
})

test(`VIX above ${VIX_HIGH} is HIGH, and ${VIX_HIGH} exactly is not`, () => {
  assert.equal(risk({ vix: { now: 30, prev: 29.5 } }).level, 'HIGH')

  const atThreshold = risk({ vix: { now: 28, prev: 28 } })
  assert.equal(atThreshold.level, 'ELEVATED')
  assert.deepEqual(atThreshold.triggered, ['VIX 28 in 20–28 band'])
})

test('a 15% day-over-day VIX jump is HIGH at the boundary', () => {
  const result = risk({ vix: { now: 23, prev: 20 } })
  assert.equal(result.level, 'HIGH')
  assert.deepEqual(result.triggered, [
    'VIX +15.0% d/d (≥15%)',
    'VIX 23 in 20–28 band',
  ])

  assert.equal(risk({ vix: { now: 22.9, prev: 20 } }).level, 'ELEVATED')
})

// --- ELEVATED -------------------------------------------------------------

test('a High-impact event inside the AM session is ELEVATED', () => {
  const result = risk({
    events: [
      event('ISM Services PMI', 'High', '2026-07-29T14:00:00Z', '10:00 ET / 16:00 CET'),
    ],
  })
  assert.equal(result.level, 'ELEVATED')
  assert.deepEqual(result.triggered, [
    'ISM Services PMI inside AM session (10:00 ET / 16:00 CET)',
  ])
})

test('the AM session window is inclusive at both ends', () => {
  const atOpen = risk({ events: [event('A', 'High', '2026-07-29T13:30:00Z')] })
  const atNoon = risk({ events: [event('B', 'High', '2026-07-29T16:00:00Z')] })
  const afterNoon = risk({ events: [event('C', 'High', '2026-07-29T16:00:01Z')] })

  assert.equal(atOpen.level, 'ELEVATED')
  assert.equal(atNoon.level, 'ELEVATED')
  assert.equal(afterNoon.level, 'LOW')
})

test('Medium-impact events inside the session do not trip the rule', () => {
  const result = risk({
    events: [event('Crude Oil Inventories', 'Medium', '2026-07-29T14:30:00Z')],
  })
  assert.equal(result.level, 'LOW')
})

test('a major print inside the digestion window is ELEVATED', () => {
  // 10 minutes before NOW.
  const result = risk({
    events: [event('Nonfarm Payrolls', 'High', '2026-07-29T11:50:00Z', '13:50')],
  })
  assert.equal(result.level, 'ELEVATED')
  assert.deepEqual(result.triggered, [
    'Nonfarm Payrolls released 10 min ago (<30 min digestion)',
  ])
})

test('past the digestion window the print stops counting', () => {
  // 31 minutes before NOW.
  const result = risk({
    events: [event('Nonfarm Payrolls', 'High', '2026-07-29T11:29:00Z')],
  })
  assert.equal(result.level, 'LOW')
  assert.deepEqual(result.triggered, [])
})

test('an unreleased second-tier inflation print is ELEVATED, not LOW and not HIGH', () => {
  const result = risk({
    events: [
      event('Core PCE Price Index m/m', 'High', '2026-07-29T12:30:00Z', '08:30 ET / 14:30 CET'),
    ],
  })

  assert.equal(result.level, 'ELEVATED')
  assert.deepEqual(result.triggered, [
    'Core PCE Price Index m/m not yet released (08:30 ET / 14:30 CET) — second-tier inflation print',
  ])
})

test('the bare PCE Price Index variant matches too', () => {
  const result = risk({
    events: [event('PCE Price Index m/m', 'High', '2026-07-29T12:30:00Z')],
  })
  assert.equal(result.level, 'ELEVATED')
})

test('a second-tier print stops counting once it has been released', () => {
  const result = risk({
    events: [event('Core PCE Price Index m/m', 'High', '2026-07-29T04:00:00Z')],
  })

  assert.equal(result.level, 'LOW')
  assert.deepEqual(result.triggered, [])
})

test('a second-tier print inside the digestion window is ELEVATED', () => {
  // 10 minutes before NOW — the half hour where PCE moves the tape like CPI.
  const result = risk({
    events: [event('Core PCE Price Index m/m', 'High', '2026-07-29T11:50:00Z')],
  })

  assert.equal(result.level, 'ELEVATED')
  assert.deepEqual(result.triggered, [
    'Core PCE Price Index m/m released 10 min ago (<30 min digestion)',
  ])
})

test('both tiers share the same digestion window', () => {
  const digestionAt = (title, iso) =>
    risk({ events: [event(title, 'High', iso)] }).triggered.length

  for (const title of ['CPI m/m', 'Core PCE Price Index m/m']) {
    assert.equal(digestionAt(title, '2026-07-29T11:50:00Z'), 1, `${title} at 10 min`)
    assert.equal(digestionAt(title, '2026-07-29T11:31:00Z'), 1, `${title} at 29 min`)
    assert.equal(digestionAt(title, '2026-07-29T11:29:00Z'), 0, `${title} at 31 min`)
  }
})

test('a digesting second-tier print does not double-fire as pre-release', () => {
  const result = risk({
    events: [event('Core PCE Price Index m/m', 'High', '2026-07-29T11:50:00Z')],
  })
  assert.equal(result.triggered.length, 1)
})

test('two prints digesting at once are both reported, still ELEVATED', () => {
  const result = risk({
    events: [
      event('CPI m/m', 'High', '2026-07-29T11:50:00Z'),
      event('Core PCE Price Index m/m', 'High', '2026-07-29T11:50:00Z'),
    ],
  })

  assert.equal(result.level, 'ELEVATED')
  assert.equal(result.triggered.length, 2)
})

test('second-tier only applies to High-impact prints', () => {
  const result = risk({
    events: [event('Core PCE Price Index m/m', 'Medium', '2026-07-29T12:30:00Z')],
  })
  assert.equal(result.level, 'LOW')
})

test('growth prints stay out of the inflation tier', () => {
  const result = risk({
    events: [
      event('Advance GDP q/q', 'High', '2026-07-29T12:30:00Z'),
      event('Advance GDP Price Index q/q', 'High', '2026-07-29T12:30:00Z'),
    ],
  })
  assert.equal(result.level, 'LOW', 'GDP is a growth print, not an inflation one')
})

test('second-tier does not promote itself, and a real HIGH still wins', () => {
  const result = risk({
    events: [
      event('CPI m/m', 'High', '2026-07-29T12:30:00Z', '08:30 ET / 14:30 CET'),
      event('Core PCE Price Index m/m', 'High', '2026-07-29T12:30:00Z', '08:30 ET / 14:30 CET'),
    ],
  })

  assert.equal(result.level, 'HIGH')
  assert.deepEqual(
    result.triggered,
    [
      'CPI m/m not yet released (08:30 ET / 14:30 CET)',
      'Core PCE Price Index m/m not yet released (08:30 ET / 14:30 CET) — second-tier inflation print',
    ],
    'the tier-one rule is reported first and sets the level'
  )
})

test('the tier-one prints keep their HIGH path untouched', () => {
  for (const title of ['CPI m/m', 'Nonfarm Payrolls', 'PPI m/m', 'Core CPI m/m']) {
    const result = risk({
      events: [event(title, 'High', '2026-07-29T12:30:00Z')],
    })
    assert.equal(result.level, 'HIGH', `${title} must still be HIGH`)
    assert.equal(result.triggered.length, 1, `${title} must fire exactly one rule`)
  }
})

test(`VIX in the ${VIX_ELEVATED_FLOOR}–${VIX_HIGH} band is ELEVATED`, () => {
  assert.equal(risk({ vix: { now: 24, prev: 24 } }).level, 'ELEVATED')
  assert.equal(risk({ vix: { now: 20, prev: 20 } }).level, 'ELEVATED')
  assert.equal(risk({ vix: { now: 19.9, prev: 19.9 } }).level, 'LOW')
})

test('VVIX above 110 is ELEVATED, and is optional', () => {
  assert.equal(risk({ vvix: 111 }).level, 'ELEVATED')
  assert.equal(risk({ vvix: 110 }).level, 'LOW')
  assert.equal(risk({ vvix: null }).level, 'LOW')
})

test('yesterday tagged Trend Day is ELEVATED', () => {
  const result = risk({
    yesterday: { date: '2026-07-28', day_type: PERSISTENT_DAY_TYPE, regime: null },
  })
  assert.equal(result.level, 'ELEVATED')
  assert.deepEqual(result.triggered, [
    'Yesterday tagged Trend Day (regime persistence)',
  ])
})

test('other day types do not carry regime risk forward', () => {
  const result = risk({
    yesterday: { date: '2026-07-28', day_type: 'Normal Day', regime: 'balance' },
  })
  assert.equal(result.level, 'LOW')
})

test('the Trend Day rule matches the controlled vocabulary', () => {
  assert.ok(
    DAY_TYPES.includes(PERSISTENT_DAY_TYPE),
    'PERSISTENT_DAY_TYPE must stay a valid day_type value'
  )
})

// --- escalation -----------------------------------------------------------

test('HIGH wins over ELEVATED however the rules are ordered', () => {
  // VVIX (ELEVATED) is evaluated after the VIX rules; FOMC (HIGH) before them.
  const result = risk({
    events: [event('FOMC Statement', 'High', '2026-07-29T18:00:00Z')],
    vvix: 130,
  })
  assert.equal(result.level, 'HIGH')
  assert.equal(result.triggered.length, 2)
})

test('an ELEVATED rule never downgrades an existing HIGH', () => {
  const result = risk({
    events: [
      // Trips HIGH (unreleased) and ELEVATED (inside session) at once.
      event('CPI m/m', 'High', '2026-07-29T14:00:00Z', '10:00 ET / 16:00 CET'),
    ],
    vix: { now: 24, prev: 24 },
    vvix: 120,
    yesterday: { date: '2026-07-28', day_type: PERSISTENT_DAY_TYPE, regime: null },
  })
  assert.equal(result.level, 'HIGH')
  assert.deepEqual(result.triggered, [
    'CPI m/m not yet released (10:00 ET / 16:00 CET)',
    'CPI m/m inside AM session (10:00 ET / 16:00 CET)',
    'VIX 24 in 20–28 band',
    'VVIX 120 > 110',
    'Yesterday tagged Trend Day (regime persistence)',
  ])
})

test('every triggering event is reported, not just the first', () => {
  const result = risk({
    events: [
      event('CPI m/m', 'High', '2026-07-29T12:30:00Z', '14:30'),
      event('PPI m/m', 'High', '2026-07-29T12:30:00Z', '14:30'),
    ],
  })
  assert.equal(result.level, 'HIGH')
  assert.equal(result.triggered.length, 2)
})

// --- yesterdayContext -----------------------------------------------------

test('yesterdayContext picks the most recent tagged prior day', () => {
  const trades = [
    { date: '2026-07-27T14:30', day_type: 'Normal Day', regime: 'balance' },
    { date: '2026-07-28T15:00', day_type: PERSISTENT_DAY_TYPE, regime: 'trend' },
    { date: '2026-07-29T09:45', day_type: 'Neutral Day', regime: 'balance' },
  ]
  assert.deepEqual(yesterdayContext(trades, NOW), {
    date: '2026-07-28',
    day_type: PERSISTENT_DAY_TYPE,
    regime: 'trend',
  })
})

test('yesterdayContext ignores untagged trades and returns null when there are none', () => {
  assert.equal(yesterdayContext([], NOW), null)
  assert.equal(
    yesterdayContext([{ date: '2026-07-28T15:00', day_type: '', regime: '' }], NOW),
    null
  )
})

test('yesterdayContext excludes today, measured in ET', () => {
  const trades = [{ date: '2026-07-29T09:45', day_type: PERSISTENT_DAY_TYPE }]
  assert.equal(yesterdayContext(trades, NOW), null)

  // 23:00 ET on the 29th: still today in New York even though UTC has rolled to
  // the 30th, so the day's own trades must stay excluded.
  const lateEvening = Date.parse('2026-07-29T23:00:00-04:00')
  assert.equal(yesterdayContext(trades, lateEvening), null)
})
