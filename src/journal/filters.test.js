import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters, byAccount, tradeLabel, NO_FILTERS, UNASSIGNED } from './filters.js'

const trade = (over = {}) => ({
  num: 1,
  date: '2026-07-01T09:30',
  type: 'Long',
  status: 'TP',
  pnl: 100,
  thesis: '',
  ...over,
})

test('no filters returns everything, newest first', () => {
  const rows = [
    trade({ num: 1, date: '2026-07-01T09:30' }),
    trade({ num: 2, date: '2026-07-03T09:30' }),
    trade({ num: 3, date: '2026-07-02T09:30' }),
  ]
  assert.deepEqual(
    applyFilters(rows, NO_FILTERS).map((t) => t.num),
    [2, 3, 1]
  )
})

test('does not mutate the input array', () => {
  const rows = [trade({ num: 1, date: '2026-07-01T09:30' }), trade({ num: 2, date: '2026-07-09T09:30' })]
  applyFilters(rows, { sort: 'pnl-low' })
  assert.deepEqual(rows.map((t) => t.num), [1, 2])
})

test('status and direction narrow independently', () => {
  const rows = [
    trade({ num: 1, status: 'TP', type: 'Long' }),
    trade({ num: 2, status: 'SL', type: 'Long' }),
    trade({ num: 3, status: 'TP', type: 'Short' }),
  ]
  assert.deepEqual(applyFilters(rows, { status: 'TP' }).map((t) => t.num).sort(), [1, 3])
  assert.deepEqual(applyFilters(rows, { direction: 'Short' }).map((t) => t.num), [3])
})

test('filters combine rather than replace each other', () => {
  const rows = [
    trade({ num: 1, status: 'TP', type: 'Long' }),
    trade({ num: 2, status: 'TP', type: 'Short' }),
    trade({ num: 3, status: 'SL', type: 'Short' }),
  ]
  assert.deepEqual(
    applyFilters(rows, { status: 'TP', direction: 'Short' }).map((t) => t.num),
    [2]
  )
})

test('search matches thesis text, case-insensitively', () => {
  const rows = [
    trade({ num: 1, thesis: 'Price went off a weekly LEDGE' }),
    trade({ num: 2, thesis: 'callwall barrier' }),
  ]
  assert.deepEqual(applyFilters(rows, { search: 'ledge' }).map((t) => t.num), [1])
})

test('search matches the composed trade label', () => {
  const rows = [trade({ num: 46 }), trade({ num: 12 })]
  assert.equal(tradeLabel(rows[0]), 'NQ #46')
  assert.deepEqual(applyFilters(rows, { search: 'nq #46' }).map((t) => t.num), [46])
})

test('search tolerates a missing thesis', () => {
  const rows = [trade({ num: 1, thesis: null }), trade({ num: 2, thesis: undefined })]
  assert.deepEqual(applyFilters(rows, { search: 'anything' }), [])
  assert.equal(applyFilters(rows, { search: 'nq' }).length, 2)
})

test('blank search is not a filter', () => {
  const rows = [trade({ num: 1, thesis: '' })]
  assert.equal(applyFilters(rows, { search: '   ' }).length, 1)
})

test('sorts by pnl in both directions', () => {
  const rows = [trade({ num: 1, pnl: -50 }), trade({ num: 2, pnl: 200 }), trade({ num: 3, pnl: 0 })]
  assert.deepEqual(applyFilters(rows, { sort: 'pnl-high' }).map((t) => t.num), [2, 3, 1])
  assert.deepEqual(applyFilters(rows, { sort: 'pnl-low' }).map((t) => t.num), [1, 3, 2])
})

test('oldest first reverses the default order', () => {
  const rows = [
    trade({ num: 1, date: '2026-07-05T09:30' }),
    trade({ num: 2, date: '2026-07-01T09:30' }),
  ]
  assert.deepEqual(applyFilters(rows, { sort: 'oldest' }).map((t) => t.num), [2, 1])
})

test('an unknown sort falls back to newest rather than throwing', () => {
  const rows = [
    trade({ num: 1, date: '2026-07-01T09:30' }),
    trade({ num: 2, date: '2026-07-08T09:30' }),
  ]
  assert.deepEqual(applyFilters(rows, { sort: 'bogus' }).map((t) => t.num), [2, 1])
})

test('rows with no date sort last without crashing', () => {
  const rows = [trade({ num: 1, date: null }), trade({ num: 2, date: '2026-07-01T09:30' })]
  assert.deepEqual(applyFilters(rows, { sort: 'newest' }).map((t) => t.num), [2, 1])
})

const accountRows = () => [
  trade({ num: 1, account_id: 'a' }),
  trade({ num: 2, account_id: 'b' }),
  trade({ num: 3, account_id: null }),
]

test('byAccount narrows to one account', () => {
  assert.deepEqual(byAccount(accountRows(), 'a').map((t) => t.num), [1])
})

test('an empty account is not a filter', () => {
  assert.equal(byAccount(accountRows(), '').length, 3)
  assert.equal(byAccount(accountRows(), undefined).length, 3)
})

test('the unassigned sentinel selects trades with no account', () => {
  assert.deepEqual(byAccount(accountRows(), UNASSIGNED).map((t) => t.num), [3])
})

test('an account with nothing on it yields nothing, not everything', () => {
  assert.deepEqual(byAccount(accountRows(), 'deleted-id'), [])
})

test('the account filter combines with the others', () => {
  const rows = [
    trade({ num: 1, account_id: 'a', status: 'TP' }),
    trade({ num: 2, account_id: 'a', status: 'SL' }),
    trade({ num: 3, account_id: 'b', status: 'TP' }),
  ]
  assert.deepEqual(
    applyFilters(rows, { account: 'a', status: 'TP' }).map((t) => t.num),
    [1]
  )
})

test('NO_FILTERS leaves every account visible', () => {
  assert.equal(applyFilters(accountRows(), NO_FILTERS).length, 3)
})
