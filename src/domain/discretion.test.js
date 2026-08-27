import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actualR, discretionDelta, isDiscretionComparable, expectancy, mechSplit, deviationCost,
} from './discretion.js'
import { normaliseConviction, tradeKind, isVeto, isRealTrade } from './veto-vocab.js'

/** A comparable row: mechanical model fired and both R values are present. */
const row = (overrides = {}) => ({
  kind: 'trade',
  pnl: 100,
  risk: 50,
  mech_trigger: 'yes',
  mech_counterfactual_r: 1,
  ...overrides,
})

test('actualR is signed P&L over recorded risk', () => {
  assert.equal(actualR(row({ pnl: 150, risk: 50 })), 3)
  assert.equal(actualR(row({ pnl: -50, risk: 50 })), -1)
})

test('actualR ignores rr, which is stored unsigned', () => {
  // rr says 2 for both; only the sign of pnl separates them.
  assert.equal(actualR(row({ pnl: -100, risk: 50, rr: 2 })), -2)
  assert.equal(actualR(row({ pnl: 100, risk: 50, rr: 2 })), 2)
})

test('actualR is null without a recorded risk, not zero', () => {
  assert.equal(actualR(row({ risk: 0 })), null)
  assert.equal(actualR(row({ risk: null })), null)
})

test('a veto returns exactly 0R — it is a decision, not missing data', () => {
  assert.equal(actualR({ kind: 'veto', pnl: 0, risk: 0 }), 0)
})

test('only mech_trigger yes rows with both R values are comparable', () => {
  assert.equal(isDiscretionComparable(row()), true)
  assert.equal(isDiscretionComparable(row({ mech_trigger: 'no' })), false)
  assert.equal(isDiscretionComparable(row({ mech_trigger: 'partial' })), false)
  assert.equal(isDiscretionComparable(row({ mech_counterfactual_r: null })), false)
  assert.equal(isDiscretionComparable(row({ risk: 0 })), false)
})

test('delta is mean actual R minus mean mechanical R', () => {
  const out = discretionDelta([
    row({ pnl: 100, risk: 50, mech_counterfactual_r: 1 }), // +2R vs +1R
    row({ pnl: 0, risk: 50, mech_counterfactual_r: 2 }), //    0R vs +2R
  ])

  assert.equal(out.n, 2)
  assert.equal(out.avgActualR, 1)
  assert.equal(out.avgMechR, 1.5)
  assert.equal(out.delta, -0.5)
})

test('a veto against a winning mechanical signal counts as a cost', () => {
  const out = discretionDelta([
    { kind: 'veto', mech_trigger: 'yes', mech_counterfactual_r: 1.8 },
  ])

  assert.equal(out.n, 1)
  assert.equal(out.avgActualR, 0)
  assert.equal(out.delta, -1.8)
})

test('rows the model never fired on are excluded, not averaged in as zero', () => {
  const out = discretionDelta([
    row({ pnl: 100, risk: 50, mech_counterfactual_r: 1 }), // comparable, +2 vs +1
    row({ mech_trigger: 'no', pnl: -500, risk: 50 }), // must not drag the mean
  ])

  assert.equal(out.n, 1)
  assert.equal(out.delta, 1)
})

test('no comparable rows yields nulls, never a zero delta', () => {
  const out = discretionDelta([row({ mech_trigger: 'no' })])
  assert.deepEqual(out, { n: 0, avgActualR: null, avgMechR: null, delta: null, tagged: 0 })
})

test('tagged counts every mech_trigger yes, comparable or not', () => {
  const out = discretionDelta([
    row(),
    row({ mech_counterfactual_r: null }), // tagged but not comparable
    row({ mech_trigger: 'partial' }),
  ])

  assert.equal(out.tagged, 2)
  assert.equal(out.n, 1)
})

test('discretionDelta on an empty journal does not divide by zero', () => {
  assert.equal(discretionDelta([]).delta, null)
  assert.equal(discretionDelta().delta, null)
})

test('a null kind is a trade — every row written before vetoes existed', () => {
  assert.equal(tradeKind({ kind: null }), 'trade')
  assert.equal(tradeKind({}), 'trade')
  assert.equal(isVeto({ kind: 'veto' }), true)
  assert.equal(isRealTrade({ kind: null }), true)
})

test('conviction clamps into range rather than rejecting the save', () => {
  assert.equal(normaliseConviction('7'), 7)
  assert.equal(normaliseConviction(11), 10)
  assert.equal(normaliseConviction(0), 1)
  assert.equal(normaliseConviction(7.6), 8)
  assert.equal(normaliseConviction(''), null)
  assert.equal(normaliseConviction(null), null)
})

/* ---- Expectancy, and the deviation cost kept out of it ---- */

test('expectancy is mean R, skipping rows with no measurable R', () => {
  const out = expectancy([
    row({ pnl: 100, risk: 50 }), // +2R
    row({ pnl: -50, risk: 50 }), // -1R
    row({ risk: 0 }), // unknown, must not count as a scratch
  ])

  assert.equal(out.n, 2)
  assert.equal(out.r, 0.5)
})

test('expectancy of nothing is null, not zero', () => {
  assert.deepEqual(expectancy([]), { n: 0, r: null })
})

test('deviation cost is the expectancy of the rows the model would not have taken', () => {
  const out = deviationCost([
    row({ mech_trigger: 'no', pnl: -50, risk: 50 }), // -1R
    row({ mech_trigger: 'no', pnl: -100, risk: 50 }), // -2R
    row({ mech_trigger: 'yes', pnl: 200, risk: 50 }), // must not rescue it
  ])

  assert.equal(out.n, 2)
  assert.equal(out.r, -1.5)
})

test('a winning mechanical book never blends away a bleeding deviation habit', () => {
  // The whole point of reporting it apart: pooled, these average to a
  // comfortable +0.5R and the -2R habit is invisible.
  const trades = [
    row({ mech_trigger: 'yes', pnl: 150, risk: 50 }), // +3R
    row({ mech_trigger: 'yes', pnl: 150, risk: 50 }), // +3R
    row({ mech_trigger: 'no', pnl: -100, risk: 50 }), // -2R
    row({ mech_trigger: 'no', pnl: -100, risk: 50 }), // -2R
  ]

  assert.equal(expectancy(trades).r, 0.5, 'pooled, the habit disappears')
  assert.equal(mechSplit(trades).fired.r, 3)
  assert.equal(mechSplit(trades).deviation.r, -2)
})

test('the mech split is disjoint and covers every row', () => {
  const trades = [
    row({ mech_trigger: 'yes' }),
    row({ mech_trigger: 'no' }),
    row({ mech_trigger: 'partial' }),
    row({ mech_trigger: null }),
    row({ mech_trigger: undefined }),
  ]
  const s = mechSplit(trades)

  assert.equal(s.fired.n, 1)
  assert.equal(s.deviation.n, 1)
  assert.equal(s.partial.n, 1)
  assert.equal(s.untagged.n, 2, 'null and undefined are both "not answered"')
  assert.equal(s.fired.n + s.deviation.n + s.partial.n + s.untagged.n, trades.length)
})

test('a veto counts as 0R in the split it belongs to', () => {
  const s = mechSplit([{ kind: 'veto', mech_trigger: 'no' }])
  assert.equal(s.deviation.r, 0)
  assert.equal(s.deviation.n, 1)
})
