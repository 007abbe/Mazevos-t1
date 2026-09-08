import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BAR_CEILING,
  BAR_FLOOR,
  FACTOR_KEYS,
  bar,
  barHistory,
  barLabel,
  biasRaw,
  conviction,
  publishRegime,
  quadrant,
  watchList,
  windLists,
} from './compose.js'

/** Factor states as the composer sees them. */
const states = (overrides = {}) =>
  Object.fromEntries(FACTOR_KEYS.map((key) => [key, { state: overrides[key] ?? 0 }]))

test('bias_raw sums the six factors, credit included at −4', () => {
  assert.equal(biasRaw(states()), 0)
  assert.equal(biasRaw(states({ inflation: -1, rates: -1, dollar: -1 })), -3)
  assert.equal(biasRaw(states({ credit: -4, rates: -2, inflation: -2, dollar: -1, liquidity: -1 })), -10)
  assert.equal(biasRaw({}), 0, 'an empty factor set is neutral, not NaN')
})

test('conviction counts only factors that agree with the sign of the bias', () => {
  // −3 from one loud factor: nothing else agrees.
  const loud = conviction(states({ credit: -3 }), -3, 'calm')
  assert.equal(loud.agreeing, 1)
  assert.equal(loud.level, 'low')

  // −3 from three quiet ones: broad agreement.
  const broad = conviction(states({ inflation: -1, rates: -1, dollar: -1 }), -3, 'calm')
  assert.equal(broad.agreeing, 3)
  assert.equal(broad.level, 'medium')

  const unanimous = conviction(
    states({ growth: -1, inflation: -1, rates: -1, liquidity: -1, credit: -1 }),
    -5,
    'calm'
  )
  assert.equal(unanimous.level, 'high')
})

test('conviction ignores disagreeing factors rather than netting them twice', () => {
  // The +1 is already paid for inside bias_raw; counting it again would be
  // double-charging the same factor.
  const mixed = conviction(states({ inflation: -1, rates: -1, dollar: -1, liquidity: 1 }), -2, 'calm')
  assert.equal(mixed.agreeing, 3)
})

test('a zero bias has no conviction to speak of', () => {
  assert.deepEqual(conviction(states({ rates: -1, liquidity: 1 }), 0, 'calm'), {
    level: 'low',
    agreeing: 0,
  })
})

test('hostile vol drops conviction exactly one notch', () => {
  const factors = states({ growth: -1, inflation: -1, rates: -1, liquidity: -1, credit: -1 })

  assert.equal(conviction(factors, -5, 'calm').level, 'high')
  assert.equal(conviction(factors, -5, 'elevated').level, 'high', 'only hostile costs a notch')
  assert.equal(conviction(factors, -5, 'hostile').level, 'medium')
  assert.equal(conviction(states({ credit: -3 }), -3, 'hostile').level, 'low', 'low cannot go lower')
})

test('the spec’s worked example reproduces exactly', () => {
  // bias_raw −3, medium conviction, elevated vol → 50 − 3×6×0.8×0.85 = 37.76
  const result = bar({ bias: -3, convictionLevel: 'medium', volRegime: 'elevated' })

  assert.equal(result.bull_pct, 38)
  assert.equal(result.bear_pct, 62)
  assert.equal(result.label, 'leaning_bear')
  assert.equal(
    result.sentence,
    '38% bull / 62% bear — leaning bear. Shorts may have a tailwind; vol regime elevated, size capped.'
  )
})

test('the bar clamps at 10 and 90 and never claims certainty', () => {
  assert.equal(bar({ bias: -20, convictionLevel: 'high', volRegime: 'calm' }).bull_pct, BAR_FLOOR)
  assert.equal(bar({ bias: 20, convictionLevel: 'high', volRegime: 'calm' }).bull_pct, BAR_CEILING)
})

test('the multipliers pull a loud bias back toward neutral', () => {
  const strong = bar({ bias: -4, convictionLevel: 'high', volRegime: 'calm' }).bull_pct
  const weak = bar({ bias: -4, convictionLevel: 'low', volRegime: 'hostile' }).bull_pct

  assert.ok(weak > strong, 'disagreement and vol both move the bar toward 50')
  assert.equal(strong, 26)
  assert.equal(weak, 41)
})

test('every label boundary lands on the right side', () => {
  const at = (pct) => barLabel(pct).key

  assert.equal(at(20), 'strong_bear')
  assert.equal(at(21), 'bear')
  assert.equal(at(35), 'bear')
  assert.equal(at(36), 'leaning_bear')
  assert.equal(at(45), 'leaning_bear')
  assert.equal(at(46), 'neutral')
  assert.equal(at(54), 'neutral')
  assert.equal(at(55), 'leaning_bull')
  assert.equal(at(64), 'leaning_bull')
  assert.equal(at(65), 'bull')
  assert.equal(at(79), 'bull')
  assert.equal(at(80), 'strong_bull')
})

test('the neutral sentence replaces the template rather than filling it in', () => {
  const result = bar({ bias: 0, convictionLevel: 'low', volRegime: 'calm' })

  assert.equal(result.label, 'neutral')
  assert.equal(
    result.sentence,
    'Neutral — no macro sponsorship either way; trade the microstructure, normal size.'
  )
  assert.doesNotMatch(result.sentence, /tailwind/)
})

test('the sentence names the side, the caveat and the vol cap', () => {
  const bearish = bar({ bias: -4, convictionLevel: 'low', volRegime: 'calm' })
  assert.match(bearish.sentence, /Shorts may have a tailwind, but conviction is low\./)
  assert.doesNotMatch(bearish.sentence, /size capped/, 'calm caps nothing')

  const bullish = bar({ bias: 4, convictionLevel: 'high', volRegime: 'hostile' })
  assert.match(bullish.sentence, /Longs may have a tailwind; vol regime hostile, size capped\./)
})

test('the quadrant reads factor states, not raw prints', () => {
  // Inflation ≥ 0 means inflation is behaving, which is the benign corner.
  assert.equal(quadrant(1, 1), 'goldilocks')
  assert.equal(quadrant(1, -1), 'overheating')
  assert.equal(quadrant(-1, -1), 'stagflation_adjacent')
  assert.equal(quadrant(-1, 1), 'slowdown')
  assert.equal(quadrant(0, 0), 'goldilocks', 'zero counts as the benign side of each axis')
  assert.equal(quadrant(null, 1), null)
})

test('a new label waits three sessions before it is published', () => {
  const prior = { label: 'neutral', since: '2026-09-01', age_days: 0 }

  let regime = publishRegime({ label: 'leaning_bear', prior, factorsChanged: 0, today: '2026-09-02' })
  assert.equal(regime.label, 'neutral')
  assert.equal(regime.pending, 'leaning_bear')
  assert.equal(regime.pending_streak, 1)

  regime = publishRegime({ label: 'leaning_bear', prior: regime, factorsChanged: 0, today: '2026-09-03' })
  assert.equal(regime.label, 'neutral')
  assert.equal(regime.pending_streak, 2)

  regime = publishRegime({ label: 'leaning_bear', prior: regime, factorsChanged: 0, today: '2026-09-04' })
  assert.equal(regime.label, 'leaning_bear')
  assert.equal(regime.since, '2026-09-04')
  assert.equal(regime.age_days, 0)
  assert.equal(regime.pending, null)
})

test('two factors flipping in one day publishes immediately', () => {
  const prior = { label: 'neutral', since: '2026-09-01' }
  const regime = publishRegime({ label: 'bear', prior, factorsChanged: 2, today: '2026-09-02' })

  assert.equal(regime.label, 'bear')
  assert.equal(regime.since, '2026-09-02')
})

test('regime_age_days counts from the day the label was published', () => {
  const prior = { label: 'leaning_bear', since: '2026-08-27' }
  const regime = publishRegime({
    label: 'leaning_bear',
    prior,
    factorsChanged: 0,
    today: '2026-09-04',
  })

  assert.equal(regime.age_days, 8)
  assert.equal(regime.since, '2026-08-27')
})

test('a pending label that changes its mind restarts the count', () => {
  let regime = publishRegime({
    label: 'bear',
    prior: { label: 'neutral', since: '2026-09-01' },
    factorsChanged: 0,
    today: '2026-09-02',
  })
  regime = publishRegime({ label: 'leaning_bull', prior: regime, factorsChanged: 0, today: '2026-09-03' })

  assert.equal(regime.pending, 'leaning_bull')
  assert.equal(regime.pending_streak, 1)
  assert.equal(regime.label, 'neutral')
})

test('the first ever computation publishes on the spot', () => {
  const regime = publishRegime({ label: 'bull', prior: null, factorsChanged: 0, today: '2026-09-08' })
  assert.equal(regime.label, 'bull')
  assert.equal(regime.age_days, 0)
})

test('windLists splits the mechanisms by sign and skips the quiet ones', () => {
  const factors = {
    growth: { state: 0, note: 'quiet' },
    inflation: { state: -1, note: 'inflation hot' },
    rates: { state: -2, note: 'real yields up' },
    liquidity: { state: 1, note: 'net liquidity rising' },
    credit: { state: 0, note: 'quiet' },
    dollar: { state: 0, note: 'quiet' },
  }

  const { headwinds, tailwinds } = windLists(factors)
  assert.deepEqual(headwinds, ['inflation hot', 'real yields up'])
  assert.deepEqual(tailwinds, ['net liquidity rising'])
})

test('watchList only lists flips inside the next five sessions', () => {
  const factors = {
    growth: { flip: { when: '2026-09-10', what: 'claims cross' } },
    inflation: { flip: { when: '2026-10-11', what: 'CPI' } },
    rates: { flip: { when: '2026-09-07', what: 'already past' } },
    liquidity: { flip: { when: null, what: 'no date' } },
    credit: { flip: { when: '2026-09-13', what: 'exactly five out' } },
    dollar: { flip: { when: '2026-09-14', what: 'six out' } },
  }

  const watch = watchList(factors, '2026-09-08')
  assert.equal(watch.length, 2)
  assert.match(watch[0], /growth input on 2026-09-10 — claims cross/)
  assert.match(watch[1], /credit/)
})

test('barHistory keeps ten, oldest first, and tolerates a broken prior', () => {
  const ten = Array.from({ length: 10 }, (_, i) => 40 + i)

  assert.deepEqual(barHistory([44, 42], 38), [44, 42, 38])
  assert.deepEqual(barHistory(ten, 38).length, 10)
  assert.equal(barHistory(ten, 38)[9], 38)
  assert.equal(barHistory(ten, 38)[0], 41, 'the oldest reading falls off the front')
  assert.deepEqual(barHistory(null, 50), [50])
  assert.deepEqual(barHistory(['x', 44, null], 50), [44, 50])
})
