import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GATING_ENABLED,
  MIN_BUCKET_N,
  bucketStats,
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

  assert.equal(report.splits.stdv_vol.total, 0)
  assert.equal(report.verdicts.mm_bias.state, 'insufficient')
})

test('every split column buckets into its own vocabulary', () => {
  // The regression: environment values were matched against the bar's
  // bear/neutral/bull, so every trade fell outside all three and the table
  // rendered three empty rows beside a non-zero total. Nothing threw.
  const trades = [
    { model: 'STDV', kind: 'trade', risk: 1, pnl: -1, macro_environment: 'headwind' },
    { model: 'STDV', kind: 'trade', risk: 1, pnl: 2, macro_environment: 'tailwind' },
  ]

  const split = splitBy(trades, 'STDV', 'macro_environment')

  assert.deepEqual(
    split.rows.map((r) => r.bucket),
    ['headwind', 'mixed', 'tailwind']
  )
  assert.equal(split.rows.find((r) => r.bucket === 'headwind').n, 1)
  assert.equal(split.rows.find((r) => r.bucket === 'tailwind').n, 1)
  assert.equal(split.unstamped, 0)
})

test('an unknown split column fails loudly rather than bucketing into nothing', () => {
  assert.throws(() => splitBy([], 'STDV', 'not_a_column'), /no bucket definition/)
})
