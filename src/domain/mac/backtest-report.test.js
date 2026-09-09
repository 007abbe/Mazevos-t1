import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bucketOf,
  buildReport,
  blockFor,
  effectiveN,
  familywiseRisk,
  monotonicity,
  signReport,
  spreadInterval,
} from './backtest-report.js'

const session = (date, bull_pct, ret, vol_regime = 'calm') => ({
  date,
  bull_pct,
  vol_regime,
  ret,
})

test('buckets follow the bar labels the card already shows', () => {
  assert.equal(bucketOf(30).key, 'bear')
  assert.equal(bucketOf(44).key, 'bear')
  assert.equal(bucketOf(50).key, 'neutral')
  assert.equal(bucketOf(60).key, 'leaning_bull')
  assert.equal(bucketOf(80).key, 'bull')
})

test('a bucket reports its own n, so a thin cell is visible as one', () => {
  const report = buildReport([session('2026-01-02', 70, 0.01)])
  const bull = report.buckets.find((b) => b.key === 'bull')

  assert.equal(bull.n, 1)
  assert.equal(report.buckets.find((b) => b.key === 'bear').n, 0)
})

test('hit rate and mean are reported against a base rate', () => {
  const report = buildReport([
    session('2026-01-02', 70, 0.02),
    session('2026-01-05', 30, -0.01),
  ])

  assert.equal(report.base.n, 2)
  assert.equal(report.base.hit_rate, 50)
  assert.equal(report.buckets.find((b) => b.key === 'bull').hit_rate, 100)
  assert.equal(report.buckets.find((b) => b.key === 'bear').hit_rate, 0)
})

test('returns are reported in basis points', () => {
  const report = buildReport([session('2026-01-02', 70, 0.0123)])
  assert.equal(report.buckets.find((b) => b.key === 'bull').mean_bps, 123)
})

test('a session with no return is excluded rather than counted as flat', () => {
  // A missing close is not a zero-return day, and treating it as one would pull
  // every mean toward nothing.
  const report = buildReport([
    session('2026-01-02', 70, 0.01),
    session('2026-01-05', 70, null),
    session('2026-01-06', 70, undefined),
  ])

  assert.equal(report.buckets.find((b) => b.key === 'bull').n, 1)
})

test('monotonicity counts steps in the right direction', () => {
  const rising = [
    { n: 5, mean_bps: -10 },
    { n: 5, mean_bps: 0 },
    { n: 5, mean_bps: 5 },
    { n: 5, mean_bps: 12 },
  ]
  assert.deepEqual(monotonicity(rising), { steps: 3, ordered: 3 })

  const jumbled = [
    { n: 5, mean_bps: 10 },
    { n: 5, mean_bps: -5 },
    { n: 5, mean_bps: 8 },
  ]
  assert.deepEqual(monotonicity(jumbled), { steps: 2, ordered: 1 })

  // Empty buckets are skipped rather than counted as a step.
  assert.deepEqual(monotonicity([{ n: 0, mean_bps: null }, { n: 3, mean_bps: 1 }]), {
    steps: 0,
    ordered: 0,
  })
})

test('the bootstrap is deterministic, so a report cannot be re-rolled', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    bucket: i % 2 ? 'bull' : 'bear',
    ret: i % 2 ? 0.002 : -0.001,
  }))

  const a = spreadInterval(rows)
  const b = spreadInterval(rows)

  assert.deepEqual(a, b)
  assert.ok(a.point_bps > 0)
})

test('the interval brackets a real separation and straddles zero for noise', () => {
  const real = Array.from({ length: 600 }, (_, i) => ({
    bucket: i % 2 ? 'bull' : 'bear',
    ret: i % 2 ? 0.004 : -0.004,
  }))
  const separated = spreadInterval(real)
  assert.ok(separated.low_bps > 0, 'a clean separation excludes zero')

  // The same returns with the labels carrying no information at all.
  const noise = Array.from({ length: 600 }, (_, i) => ({
    bucket: i % 2 ? 'bull' : 'bear',
    ret: Math.sin(i) * 0.01,
  }))
  const none = spreadInterval(noise)
  assert.ok(none.low_bps <= 0 && none.high_bps >= 0, 'noise straddles zero')
})

test('the bootstrap declines rather than guessing on too little data', () => {
  assert.equal(spreadInterval([{ bucket: 'bull', ret: 0.01 }]), null)

  // Plenty of rows, but nothing in the bear bucket to compare against.
  const oneSided = Array.from({ length: 200 }, () => ({ bucket: 'bull', ret: 0.01 }))
  assert.equal(spreadInterval(oneSided), null)
})

test('vol regimes are summarised separately', () => {
  const report = buildReport([
    session('2026-01-02', 70, 0.01, 'calm'),
    session('2026-01-05', 30, -0.05, 'hostile'),
  ])

  assert.equal(report.by_vol.find((v) => v.regime === 'calm').n, 1)
  assert.equal(report.by_vol.find((v) => v.regime === 'hostile').mean_bps, -500)
})

test('dispersion and the left tail are reported, not just the mean', () => {
  // The size cap is a claim about risk. A regime can carry an ordinary mean
  // while doubling the spread around it, and a table of means alone would
  // report that as no effect at all.
  const calm = Array.from({ length: 100 }, (_, i) => session(`2026-01-${i}`, 50, i % 2 ? 0.001 : -0.001, 'calm'))
  const wild = Array.from({ length: 100 }, (_, i) => session(`2026-02-${i}`, 50, i % 2 ? 0.05 : -0.05, 'hostile'))

  const report = buildReport([...calm, ...wild])
  const c = report.by_vol.find((v) => v.regime === 'calm')
  const h = report.by_vol.find((v) => v.regime === 'hostile')

  assert.ok(Math.abs(c.mean_bps - h.mean_bps) < 1, 'identical means')
  assert.ok(h.sd_bps > c.sd_bps * 10, 'but the spread is what separates them')
  assert.ok(h.p05_bps < c.p05_bps, 'and the left tail is far worse')
})

test('a single-session bucket reports zero dispersion rather than NaN', () => {
  const report = buildReport([session('2026-01-02', 70, 0.01)])
  assert.equal(report.buckets.find((b) => b.key === 'bull').sd_bps, 0)
})

test('signReport buckets a factor by the sign of its state', () => {
  const rows = [
    { date: '2026-01-02', f: 2, ret: 0.02 },
    { date: '2026-01-05', f: 1, ret: 0.01 },
    { date: '2026-01-06', f: 0, ret: 0.0 },
    { date: '2026-01-07', f: -1, ret: -0.01 },
    { date: '2026-01-08', f: -2, ret: -0.03 },
  ]

  const report = signReport(rows, 'f')
  const byKey = Object.fromEntries(report.buckets.map((b) => [b.key, b]))

  assert.equal(byKey.positive.n, 2)
  assert.equal(byKey.zero.n, 1)
  assert.equal(byKey.negative.n, 2)
  assert.equal(byKey.positive.mean_bps, 150)
})

test('signReport finds an inverted factor rather than calling it dead', () => {
  // A flipped sign is not a factor without signal — it is a factor dragging the
  // composite the wrong way, and it has to be distinguishable from noise.
  const rows = Array.from({ length: 400 }, (_, i) => ({
    date: `2026-01-${i}`,
    f: i % 2 ? 1 : -1,
    ret: i % 2 ? -0.004 : 0.004,
  }))

  const report = signReport(rows, 'f')
  assert.ok(report.spread.high_bps < 0, 'a consistently inverted factor reads negative')
})

test('signReport ignores sessions with no state for that factor', () => {
  const report = signReport(
    [
      { date: '2026-01-02', f: 1, ret: 0.01 },
      { date: '2026-01-05', ret: 0.01 },
      { date: '2026-01-06', f: null, ret: 0.01 },
    ],
    'f'
  )

  assert.equal(report.n, 1)
})

test('familywiseRisk states the cost of searching several factors at once', () => {
  assert.equal(familywiseRisk(1), 5)
  assert.equal(familywiseRisk(6), 26.5)
  assert.ok(familywiseRisk(6) > familywiseRisk(3))
})

test('the bootstrap block grows with the holding horizon', () => {
  // Overlapping 20-day returns share 19 of their 20 days. A block shorter than
  // the dependence resamples chunks smaller than the thing it is meant to
  // preserve, and reports an interval far tighter than the evidence supports.
  assert.equal(blockFor(1), 21)
  assert.equal(blockFor(5), 21)
  assert.equal(blockFor(20), 80)
  assert.ok(blockFor(20) > 20, 'the block must exceed the overlap it is protecting against')
})

test('effectiveN reports the sample that overlapping returns actually hold', () => {
  assert.equal(effectiveN(2500, 1), 2500)
  assert.equal(effectiveN(2500, 20), 125)
  assert.equal(effectiveN(10, 0), 10)
})

test('buildReport and signReport can score any return field', () => {
  const rows = [
    { date: '2026-01-02', bull_pct: 70, f: 1, ret: 0.001, ret_20: 0.05 },
    { date: '2026-01-05', bull_pct: 30, f: -1, ret: -0.001, ret_20: -0.04 },
  ]

  assert.equal(buildReport(rows, { field: 'ret_20' }).base.n, 2)
  assert.equal(
    signReport(rows, 'f', { ret: 'ret_20' }).buckets.find((b) => b.key === 'positive').mean_bps,
    500
  )
})
