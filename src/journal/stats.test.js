import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStats } from './stats.js'

/**
 * The header tiles. Most of the arithmetic here is FlowJournal's and predates
 * this file; what is tested is the one rule that is easy to break by accident —
 * a veto row is not a trade, and must not reach any tile that has a dollar sign
 * or a percent in it.
 */

const won = (over = {}) => ({ kind: 'trade', pnl: 100, risk: 50, ...over })
const lost = (over = {}) => ({ kind: 'trade', pnl: -50, risk: 50, ...over })
const veto = (over = {}) => ({ kind: 'veto', pnl: 0, risk: 0, ...over })

test('a veto adds nothing to the trade count', () => {
  assert.equal(computeStats([won(), lost(), veto()]).count, 2)
})

test('a veto is counted, separately, so it is not simply invisible', () => {
  assert.equal(computeStats([won(), veto(), veto()]).vetoes, 2)
  assert.equal(computeStats([won()]).vetoes, 0)
})

test('a veto does not dilute the win rate', () => {
  // Two trades, one winner: 50%. Adding two vetoes must not make it 25%.
  assert.equal(computeStats([won(), lost()]).winRate, 50)
  assert.equal(computeStats([won(), lost(), veto(), veto()]).winRate, 50)
})

test('a veto does not move net P&L, profit factor or the averages', () => {
  const without = computeStats([won(), lost()])
  const with_ = computeStats([won(), lost(), veto(), veto()])

  assert.equal(with_.netPnl, without.netPnl)
  assert.equal(with_.profitFactor, without.profitFactor)
  assert.equal(with_.avgWin, without.avgWin)
  assert.equal(with_.avgLoss, without.avgLoss)
})

test('a veto does not drag average R toward zero', () => {
  // The trap: a veto has risk 0, so it is already excluded from the R sample by
  // the non-zero-risk guard. This pins that, because a veto that recorded a
  // risk would otherwise average in as a 0R trade.
  assert.equal(computeStats([won()]).avgR, 2)
  assert.equal(computeStats([won(), veto({ risk: 50 })]).avgR, 2)
})

test('a journal of nothing but vetoes reports no trades, not a zero win rate', () => {
  const stats = computeStats([veto(), veto()])
  assert.equal(stats.count, 0)
  assert.equal(stats.vetoes, 2)
  assert.equal(stats.netPnl, 0)
  assert.equal(stats.avgR, null)
  assert.equal(stats.profitFactor, null)
})

test('a null kind counts as a trade — every row logged before vetoes existed', () => {
  assert.equal(computeStats([{ pnl: 100, risk: 50 }]).count, 1)
  assert.equal(computeStats([{ kind: null, pnl: 100, risk: 50 }]).vetoes, 0)
})
