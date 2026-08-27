import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pointStats, stopPoints, takeProfitPoints } from './points.js'

const trade = (over = {}) => ({
  pnl: 100,
  entry_price: 19900,
  planned_stop: 19880,
  actual_exit: 19940,
  ...over,
})

test('a stop is the distance from entry, whichever side it sits on', () => {
  assert.equal(stopPoints(trade({ entry_price: 19900, planned_stop: 19880 })), 20)
  // Short: the stop is above the entry and the distance is still 20.
  assert.equal(stopPoints(trade({ entry_price: 19880, planned_stop: 19900 })), 20)
})

test('a trade missing either price has no stop distance, not a zero one', () => {
  assert.equal(stopPoints(trade({ entry_price: null })), null)
  assert.equal(stopPoints(trade({ planned_stop: null })), null)
  assert.equal(stopPoints(trade({ planned_stop: '' })), null)
  assert.equal(stopPoints({}), null)
})

test('entry and stop at the same price is a slip, not a zero-risk trade', () => {
  assert.equal(stopPoints(trade({ entry_price: 19900, planned_stop: 19900 })), null)
})

test('prices arrive from Postgres as strings and still subtract', () => {
  assert.equal(stopPoints(trade({ entry_price: '19900.00', planned_stop: '19880.50' })), 19.5)
})

test('take profit is measured on winners only', () => {
  assert.equal(takeProfitPoints(trade({ pnl: 100 })), 40)
  // A loser's entry-to-exit distance is a stop wearing a target's clothes.
  assert.equal(takeProfitPoints(trade({ pnl: -50 })), null)
  assert.equal(takeProfitPoints(trade({ pnl: 0 })), null)
})

test('stops and targets carry their own sample sizes', () => {
  // Three trades have a stop; only the two winners have a target.
  const stats = pointStats([
    trade({ pnl: 100, entry_price: 19900, planned_stop: 19880, actual_exit: 19940 }),
    trade({ pnl: 200, entry_price: 19900, planned_stop: 19890, actual_exit: 19960 }),
    trade({ pnl: -50, entry_price: 19900, planned_stop: 19870, actual_exit: 19870 }),
  ])

  assert.equal(stats.stopN, 3)
  assert.equal(stats.targetN, 2)
  assert.equal(stats.avgStop, 20) // (20 + 10 + 30) / 3
  assert.equal(stats.avgTarget, 50) // (40 + 60) / 2
})

test('the tightest and widest stop bracket the average', () => {
  const stats = pointStats([
    trade({ planned_stop: 19880 }), // 20
    trade({ planned_stop: 19890 }), // 10
    trade({ planned_stop: 19870 }), // 30
  ])

  assert.equal(stats.minStop, 10)
  assert.equal(stats.maxStop, 30)
})

test('the ratio is realised reward over realised risk, in points', () => {
  const stats = pointStats([trade({ pnl: 100, planned_stop: 19880, actual_exit: 19940 })])
  assert.equal(stats.ratio, 2) // 40 points taken against a 20 point stop
})

test('an empty journal reports nulls rather than dividing by zero', () => {
  const stats = pointStats([])
  assert.equal(stats.avgStop, null)
  assert.equal(stats.avgTarget, null)
  assert.equal(stats.ratio, null)
  assert.equal(stats.minStop, null)
  assert.equal(stats.stopN, 0)
})

test('trades with no prices recorded contribute nothing at all', () => {
  // Every row logged before entry_price reached STDV looks like this.
  const stats = pointStats([{ pnl: 100 }, { pnl: -50 }])
  assert.equal(stats.stopN, 0)
  assert.equal(stats.avgStop, null)
})
