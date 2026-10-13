import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tradeTicks, tickTally, fmtTicks, periodRange, inRange } from './ticks.js'

const trade = (over = {}) => ({
  type: 'Long',
  model: 'STDV',
  entry_price: 19900,
  actual_exit: 19950,
  date: '2026-10-13T15:45',
  ...over,
})

test('a long collects exit minus entry, in quarter-point ticks', () => {
  assert.equal(tradeTicks(trade()), 200)
  assert.equal(tradeTicks(trade({ actual_exit: 19875 })), -100)
})

test('a short collects entry minus exit', () => {
  assert.equal(tradeTicks(trade({ type: 'Short', actual_exit: 19850 })), 200)
  assert.equal(tradeTicks(trade({ type: 'Short', actual_exit: 19910 })), -40)
})

test('a 200-tick winner and a 100-tick loser collect +100', () => {
  const t = tickTally([trade(), trade({ actual_exit: 19875 })])
  assert.deepEqual(t, { net: 100, gained: 200, lost: -100, n: 2, best: 200, worst: -100, suspect: [] })
})

test('x, vetoes, open trades and rows missing a price do not count', () => {
  assert.equal(tradeTicks(trade({ model: 'x' })), null)
  assert.equal(tradeTicks(trade({ kind: 'veto' })), null)
  assert.equal(tradeTicks(trade({ actual_exit: null })), null)
  assert.equal(tradeTicks(trade({ entry_price: '' })), null)
  assert.equal(tradeTicks(trade({ type: null })), null)
  assert.equal(tickTally([trade({ model: 'x' })]).n, 0)
})

test('a trade with no model predates the column and is STDV, so it counts', () => {
  assert.equal(tradeTicks(trade({ model: null })), 200)
})

test('string prices with quarter fractions round to whole ticks', () => {
  assert.equal(tradeTicks(trade({ entry_price: '19900.75', actual_exit: '19901.5' })), 3)
})

test('an empty tally is zero net with no best or worst', () => {
  assert.deepEqual(tickTally([]), { net: 0, gained: 0, lost: 0, n: 0, best: null, worst: null, suspect: [] })
})

test('ticks print with their sign', () => {
  assert.equal(fmtTicks(1200), '+1,200')
  assert.equal(fmtTicks(-40), '-40')
  assert.equal(fmtTicks(0), '0')
  assert.equal(fmtTicks(null), '—')
})

test('a week starts on Monday, a month on the 1st', () => {
  const tue = new Date(2026, 9, 13) // Tuesday 13 Oct 2026
  assert.deepEqual(periodRange('week', tue), { from: '2026-10-12', to: null })
  assert.deepEqual(periodRange('month', tue), { from: '2026-10-01', to: null })
  const sun = new Date(2026, 9, 18)
  assert.equal(periodRange('week', sun).from, '2026-10-12')
  assert.deepEqual(periodRange('all', tue), { from: null, to: null })
  assert.deepEqual(periodRange('custom', tue, { from: '2026-09-01', to: '' }), { from: '2026-09-01', to: null })
})

test('range bounds are inclusive days and undated rows only appear in all-time', () => {
  const rows = [
    trade({ date: '2026-10-11T23:59' }),
    trade({ date: '2026-10-12T09:30' }),
    trade({ date: '2026-10-13T15:45' }),
    trade({ date: null }),
  ]
  assert.equal(inRange(rows, { from: '2026-10-12', to: null }).length, 2)
  assert.equal(inRange(rows, { from: '2026-10-12', to: '2026-10-12' }).length, 1)
  assert.equal(inRange(rows, {}).length, 4)
})

test('a mistyped price is held out and named, not collected', () => {
  const typo = trade({ num: 47, entry_price: 24900, actual_exit: 2490 }) // dropped a digit
  const t = tickTally([trade(), typo])
  assert.equal(t.net, 200)
  assert.equal(t.n, 1)
  assert.deepEqual(t.suspect, [typo])
})

test('a big but real move still counts', () => {
  // 400 points is a huge NQ day, not a typo.
  assert.equal(tickTally([trade({ actual_exit: 20300 })]).net, 1600)
})
