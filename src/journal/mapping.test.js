import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toRow, fromRow, stampNow, uid, toDatetimeLocal, isValidTradeDate } from './mapping.js'
import {
  TYPES, STATUSES, SETUP_TYPES, BANDS, TARGETS, REGIMES, BE_REASONS, DAY_TYPES,
  RULE_BROKEN_VALUES,
} from '../domain/trade-vocab.js'

const USER = '00000000-0000-0000-0000-000000000001'

/** A row shaped exactly as Postgres returns it: numerics as strings. */
const dbRow = {
  id: 'mdq1x2ab',
  user_id: USER,
  num: 42,
  date: '2026-07-24T14:30',
  type: 'Long',
  status: 'TP1+BE',
  pnl: '412.50',
  risk: '150',
  rr: '2.75',
  thesis: 'Bounce off -2σ with away-stack',
  hindsight: 'Held too long',
  image: 'data:image/jpeg;base64,/9j/4AAQ',
  setup_type: 'B',
  band_touched: '-2σ',
  away_stack: true,
  stack_ratio: '1.8',
  entry_delay_sec: 12,
  planned_stop: '19850.25',
  actual_exit: '19912.75',
  target: 'VWAP',
  be_moved: true,
  be_reason: 'structure',
  regime: 'trend',
  day_type: 'Normal Variation',
  news_window: false,
  rule_broken: ['early_entry', 'traded_news'],
  updated_at: 1753363800000,
}

test('fromRow -> toRow round-trips every column', () => {
  const roundTripped = toRow(fromRow(dbRow), USER)

  // Numerics come back as JS numbers, which is the same value Postgres stores.
  assert.deepEqual(roundTripped, {
    ...dbRow,
    pnl: 412.5,
    risk: 150,
    rr: 2.75,
    stack_ratio: 1.8,
    planned_stop: 19850.25,
    actual_exit: 19912.75,
  })
})

test('round-trip covers the full column set — no field silently dropped', () => {
  const COLUMNS = [
    'id', 'user_id', 'num', 'date', 'type', 'status', 'pnl', 'risk', 'rr',
    'thesis', 'hindsight', 'image', 'updated_at', 'setup_type', 'band_touched',
    'away_stack', 'stack_ratio', 'entry_delay_sec', 'planned_stop',
    'actual_exit', 'target', 'be_moved', 'be_reason', 'regime', 'day_type',
    'news_window', 'rule_broken',
  ]
  assert.deepEqual(Object.keys(toRow(fromRow(dbRow), USER)).sort(), [...COLUMNS].sort())
})

test('an empty row survives the round-trip with FlowJournal defaults', () => {
  const empty = toRow(fromRow({ id: 'x', updated_at: 1 }), USER)
  assert.equal(empty.pnl, 0)
  assert.equal(empty.risk, 0)
  assert.equal(empty.rr, 0)
  assert.deepEqual(empty.rule_broken, [], 'rule_broken must never be null')
  assert.equal(empty.away_stack, false)
  assert.equal(empty.be_moved, false)
  assert.equal(empty.news_window, false)
})

test('null text fields normalise to empty string, not back to null', () => {
  // fromRow does `r.thesis || ''`, and toRow's `?? null` does not catch ''.
  // So a NULL thesis in the DB is rewritten as '' the first time a trade is
  // saved. This is FlowJournal's existing behaviour, preserved deliberately.
  const row = toRow(fromRow({ id: 'x', thesis: null, hindsight: null, updated_at: 1 }), USER)
  assert.equal(row.thesis, '')
  assert.equal(row.hindsight, '')
})

test('updated_at stays epoch milliseconds through the round-trip', () => {
  assert.equal(toRow(fromRow(dbRow), USER).updated_at, 1753363800000)
  assert.equal(typeof toRow(fromRow(dbRow), USER).updated_at, 'number')
})

test('toRow refuses anything that is not epoch milliseconds', () => {
  // The data-loss guard: each of these collapses to 0 in FlowJournal's
  // `Number(r.updated_at) || 0` merge, making it treat cloud rows as stale.
  for (const bad of [
    new Date(1753363800000),
    '2026-07-24T14:30:00Z',
    '1753363800000',
    1753363800000.5,
    0,
    -1,
    NaN,
  ]) {
    assert.throws(
      () => toRow({ id: 'x', updatedAt: bad }, USER),
      TypeError,
      `should reject updatedAt=${String(bad)}`
    )
  }
})

test('absent updated_at defaults to now; null and undefined mean the same', () => {
  for (const t of [{ id: 'x' }, { id: 'x', updatedAt: null }, { id: 'x', updatedAt: undefined }]) {
    const before = Date.now()
    const { updated_at } = toRow(t, USER)
    assert.ok(Number.isInteger(updated_at) && updated_at >= before)
  }
})

test('toRow requires a user id', () => {
  assert.throws(() => toRow({ id: 'x', updatedAt: 1 }), /user id/)
})

test('stampNow refreshes updatedAt on a trade read back from the DB', () => {
  // The edit-loses-the-write bug: without stampNow, saving a trade that was
  // read via fromRow writes back its stored timestamp, so FlowJournal's merge
  // sees no change and can clobber the edit with its stale local copy.
  const stored = fromRow(dbRow)
  assert.equal(stored.updatedAt, 1753363800000)

  const before = Date.now()
  const saved = toRow(stampNow(stored), USER)
  assert.ok(saved.updated_at >= before, 'stamp must be current, not the stored value')
  assert.notEqual(saved.updated_at, 1753363800000)
})

test('stampNow does not mutate its input', () => {
  const stored = fromRow(dbRow)
  stampNow(stored)
  assert.equal(stored.updatedAt, 1753363800000)
})

test('uid does not collide, even minting in a tight loop', () => {
  // `id` is the upsert conflict key, so a collision overwrites a real trade.
  // FlowJournal's 4-char random suffix fails this at ~4 per 10k.
  const N = 200000
  const ids = new Set(Array.from({ length: N }, uid))
  assert.equal(ids.size, N, 'ids must not collide')
})

test('uid stays a plain lowercase alphanumeric string', () => {
  for (const id of Array.from({ length: 100 }, uid)) {
    assert.match(id, /^[a-z0-9]+$/, 'text column and URL-safe: no dashes, no padding')
  }
})

test('uid sorts by creation across milliseconds', async () => {
  // Only across milliseconds: ids minted inside one millisecond share the
  // timestamp prefix, so the random suffix decides their relative order.
  const a = uid()
  await new Promise((r) => setTimeout(r, 2))
  const b = uid()
  assert.ok(a < b, `${a} should sort before ${b}`)
  assert.equal(a.length, b.length, 'fixed width, so lexicographic order is stable')
})

test('a new trade round-trips through the full write shape', () => {
  const created = toRow(stampNow({ id: uid(), num: 1, date: '2026-07-28T09:15', type: 'Short' }), USER)
  assert.equal(created.user_id, USER)
  assert.equal(created.pnl, 0)
  assert.deepEqual(created.rule_broken, [])
  assert.ok(Number.isInteger(created.updated_at))
})

test('toDatetimeLocal emits the exact shape the date column expects', () => {
  assert.equal(toDatetimeLocal(new Date(2026, 0, 5, 9, 7)), '2026-01-05T09:07')
  assert.equal(toDatetimeLocal(new Date(2026, 11, 31, 23, 59)), '2026-12-31T23:59')
  assert.match(toDatetimeLocal(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
})

test('toDatetimeLocal output sorts lexicographically in chronological order', () => {
  // `date` is a text column and listTrades orders on it, so string order has to
  // match time order — that is the whole reason for the zero padding.
  const dates = [
    new Date(2026, 0, 5, 9, 7),
    new Date(2026, 0, 5, 10, 0),
    new Date(2026, 9, 1, 0, 0),
    new Date(2027, 0, 1, 0, 0),
  ].map(toDatetimeLocal)
  assert.deepEqual([...dates].sort(), dates)
})

test('isValidTradeDate accepts the column format and rejects the rest', () => {
  assert.ok(isValidTradeDate('2026-07-24T14:30'))
  assert.ok(isValidTradeDate('2026-07-24T14:30:00'))
  for (const bad of ['', '2026-07-24', '24/07/2026 14:30', 'yesterday', null, undefined, 12345]) {
    assert.ok(!isValidTradeDate(bad), `should reject ${JSON.stringify(bad)}`)
  }
})

test('vocabulary values match what FlowJournal writes', () => {
  assert.deepEqual(TYPES, ['Long', 'Short'])
  assert.deepEqual(STATUSES, ['Open', 'TP', 'SL', 'BE', 'TP1+BE'])
  assert.deepEqual(SETUP_TYPES, ['A', 'B', 'C'])
  assert.deepEqual([...BANDS].sort(), ['+2.6σ', '+2σ', '-2.6σ', '-2σ'].sort())
  assert.deepEqual(TARGETS, ['VWAP', 'POC', 'HVN'])
  assert.deepEqual(REGIMES, ['trend', 'balance', 'volatile'])
  assert.deepEqual(BE_REASONS, ['fear', 'structure'])
  assert.equal(DAY_TYPES.length, 8)
  assert.deepEqual(
    [...RULE_BROKEN_VALUES].sort(),
    ['be_fear', 'chased_entry', 'early_entry', 'no_away_stack', 'other', 'size_over_cap', 'traded_news']
  )
})

test('the sample row only uses valid vocabulary values', () => {
  const t = fromRow(dbRow)
  assert.ok(TYPES.includes(t.type))
  assert.ok(STATUSES.includes(t.status))
  assert.ok(SETUP_TYPES.includes(t.setup_type))
  assert.ok(BANDS.includes(t.band_touched))
  assert.ok(REGIMES.includes(t.regime))
  assert.ok(BE_REASONS.includes(t.be_reason))
  assert.ok(DAY_TYPES.includes(t.day_type))
  assert.ok(t.rule_broken.every((r) => RULE_BROKEN_VALUES.includes(r)))
})
