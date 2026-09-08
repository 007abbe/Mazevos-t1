import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GATING_ENABLED,
  MIN_BUCKET_N,
  barCalibration,
  bucketStats,
  greenSessions,
  splitBy,
  validationReport,
  verdictFor,
} from './validation.js'

/** A live trade with a measurable R. */
const trade = (overrides = {}) => ({
  model: 'STDV',
  risk: 100,
  pnl: 100,
  kind: 'trade',
  vol_regime: 'calm',
  regime_bias: 'neutral',
  ...overrides,
})

/** `n` trades in one bucket, each returning `r`. */
const trades = (n, r, overrides = {}) =>
  Array.from({ length: n }, () => trade({ pnl: r * 100, ...overrides }))

test('mac is display-only until Phase 4 says otherwise', () => {
  // The whole logging phase depends on this staying false. Flipping it is a
  // deliberate act backed by the tables, never a default that drifted.
  assert.equal(GATING_ENABLED, false)
})

test('greenSessions compares each close to the previous observation', () => {
  const green = greenSessions([
    { date: '2026-09-04', value: 100 },
    { date: '2026-09-08', value: 101 },
    { date: '2026-09-09', value: 99 },
  ])

  // Monday is measured against Friday, not against a missing Sunday.
  assert.equal(green.get('2026-09-08'), true)
  assert.equal(green.get('2026-09-09'), false)
  assert.equal(green.has('2026-09-04'), false, 'the first close has no prior to compare to')
})

test('barCalibration scores a snapshot against its own session', () => {
  const rows = [
    { date: '2026-09-08', snapshot: { date: '2026-09-08', l1: { bar: { bull_pct: 70 } } } },
    { date: '2026-09-09', snapshot: { date: '2026-09-09', l1: { bar: { bull_pct: 30 } } } },
  ]
  const closes = [
    { date: '2026-09-07', value: 100 },
    { date: '2026-09-08', value: 101 },
    { date: '2026-09-09', value: 100 },
  ]

  const calibration = barCalibration(rows, closes)

  assert.equal(calibration.sessions, 2)
  assert.equal(calibration.buckets.find((b) => b.label === '≥65').actual, 100)
  assert.equal(calibration.buckets.find((b) => b.label === '≤35').actual, 0)
})

test('a bucket nothing landed in reports null, not zero percent', () => {
  const calibration = barCalibration([], [])

  for (const bucket of calibration.buckets) {
    assert.equal(bucket.actual, null, 'zero would read as "never green"')
    assert.equal(bucket.n, 0)
  }
  assert.equal(calibration.enough, false)
})

test('calibration drops sessions with no matching close rather than guessing', () => {
  const rows = [
    { date: '2026-12-25', snapshot: { date: '2026-12-25', l1: { bar: { bull_pct: 70 } } } },
  ]
  const closes = [
    { date: '2026-12-24', value: 100 },
    { date: '2026-12-28', value: 101 },
  ]

  assert.equal(barCalibration(rows, closes).sessions, 0)
})

test('calibration needs 60 sessions before it claims to be enough', () => {
  const closes = [{ date: '2026-01-01', value: 100 }]
  const rows = []

  for (let i = 1; i <= 60; i += 1) {
    const date = `2026-${String(Math.floor((i - 1) / 28) + 1).padStart(2, '0')}-${String(((i - 1) % 28) + 2).padStart(2, '0')}`
    closes.push({ date, value: 100 + i })
    rows.push({ date, snapshot: { date, l1: { bar: { bull_pct: 60 } } } })
  }

  assert.equal(barCalibration(rows.slice(0, 59), closes).enough, false)
  assert.equal(barCalibration(rows, closes).enough, true)
})

test('bucketStats reports expectancy, win rate and n together', () => {
  const stats = bucketStats([trade({ pnl: 200 }), trade({ pnl: -100 })])

  assert.equal(stats.n, 2)
  assert.equal(stats.r, 0.5)
  assert.equal(stats.win_rate, 50)
  assert.equal(stats.enough, false, `2 is below the ${MIN_BUCKET_N} floor`)
})

test('splitBy scopes to one model and buckets the rest', () => {
  const split = splitBy(
    [
      ...trades(3, 1, { vol_regime: 'calm' }),
      ...trades(2, -1, { vol_regime: 'hostile' }),
      ...trades(4, 1, { model: 'MM', vol_regime: 'calm' }),
    ],
    'STDV',
    'vol_regime'
  )

  assert.equal(split.total, 5, 'MM trades are not STDV trades')
  assert.equal(split.rows.find((r) => r.bucket === 'calm').n, 3)
  assert.equal(split.rows.find((r) => r.bucket === 'hostile').r, -1)
  assert.equal(split.rows.find((r) => r.bucket === 'elevated').n, 0)
})

test('splitBy collapses the seven bar labels to three', () => {
  const split = splitBy(
    [
      ...trades(2, 1, { regime_bias: 'strong_bull' }),
      ...trades(2, 1, { regime_bias: 'leaning_bull' }),
      ...trades(1, -1, { regime_bias: 'strong_bear' }),
    ],
    'STDV',
    'regime_bias'
  )

  assert.equal(split.rows.find((r) => r.bucket === 'bull').n, 4)
  assert.equal(split.rows.find((r) => r.bucket === 'bear').n, 1)
})

test('trades logged before mac are counted as unstamped, not as neutral', () => {
  const split = splitBy([...trades(3, 1, { vol_regime: null }), ...trades(2, 1)], 'STDV', 'vol_regime')

  assert.equal(split.unstamped, 3)
  assert.equal(split.rows.find((r) => r.bucket === 'calm').n, 2)
})

test('a thin bucket yields no verdict at all', () => {
  const split = splitBy([...trades(3, -1, { vol_regime: 'hostile' }), ...trades(3, 1)], 'STDV', 'vol_regime')
  const verdict = verdictFor(split, { low: 'hostile', high: 'calm' })

  assert.equal(verdict.state, 'insufficient')
  assert.match(verdict.text, /hostile has 3\/20/)
})

test('separation is only claimed when both ends are populated and far apart', () => {
  const split = splitBy(
    [...trades(25, -0.8, { vol_regime: 'hostile' }), ...trades(25, 0.6)],
    'STDV',
    'vol_regime'
  )
  const verdict = verdictFor(split, { low: 'hostile', high: 'calm' })

  assert.equal(verdict.state, 'separated')
  assert.match(verdict.text, /1\.40R/)
  assert.match(verdict.text, /Screen only/, 'never dressed up as a significance test')
})

test('a small gap is reported as no separation, and blames the definition', () => {
  const split = splitBy(
    [...trades(25, 0.5, { vol_regime: 'hostile' }), ...trades(25, 0.6)],
    'STDV',
    'vol_regime'
  )
  const verdict = verdictFor(split, { low: 'hostile', high: 'calm' })

  assert.equal(verdict.state, 'no_separation')
  assert.match(verdict.text, /definition is wrong, not the trades/)
})

test('the report answers the spec’s two named questions', () => {
  const report = validationReport({ trades: trades(5, 1), snapshots: [], closes: [] })

  assert.equal(report.gating_enabled, false)
  assert.ok(report.verdicts.stdv_vol, 'does hostile hurt STDV')
  assert.ok(report.verdicts.mm_bias, 'does the bar separate MM')
  assert.equal(report.verdicts.stdv_vol.state, 'insufficient')
})

test('an empty journal produces a report rather than a crash', () => {
  const report = validationReport({})

  assert.equal(report.calibration.sessions, 0)
  assert.equal(report.splits.stdv_vol.total, 0)
  assert.equal(report.verdicts.mm_bias.state, 'insufficient')
})
