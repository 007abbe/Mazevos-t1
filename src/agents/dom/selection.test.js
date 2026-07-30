import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeScope,
  localDate,
  selectThisWeek,
  selectToday,
  weekStart,
} from './selection.js'

/** Thursday 30 July 2026, mid-afternoon local. */
const NOW = new Date('2026-07-30T15:30').getTime()

const trade = (date, id = date) => ({ id, date })

test('localDate reads the browser zone, in the same format the column stores', () => {
  assert.equal(localDate(new Date('2026-07-30T15:30').getTime()), '2026-07-30')
  assert.match(localDate(NOW), /^\d{4}-\d{2}-\d{2}$/)
})

test('a late-evening trade stays on its own local day', () => {
  // The exact case ET bucketing would get wrong: 23:00 local is already
  // tomorrow in UTC.
  const lateEvening = new Date('2026-07-30T23:00').getTime()
  assert.equal(localDate(lateEvening), '2026-07-30')

  const selected = selectToday([trade('2026-07-30T23:00')], lateEvening)
  assert.equal(selected.length, 1)
})

test('selectToday matches on the date part only', () => {
  const selected = selectToday(
    [
      trade('2026-07-30T09:15'),
      trade('2026-07-30T16:45'),
      trade('2026-07-29T15:30'),
      trade('2026-07-31T15:30'),
    ],
    NOW
  )

  assert.deepEqual(
    selected.map((t) => t.id),
    ['2026-07-30T09:15', '2026-07-30T16:45']
  )
})

test('weekStart is the Monday on or before now', () => {
  // 30 July 2026 is a Thursday; that week's Monday is the 27th.
  assert.equal(weekStart(NOW), '2026-07-27')

  const monday = new Date('2026-07-27T08:00').getTime()
  assert.equal(weekStart(monday), '2026-07-27', 'Monday is its own week start')

  const sunday = new Date('2026-08-02T22:00').getTime()
  assert.equal(weekStart(sunday), '2026-07-27', 'Sunday closes the same week')
})

test('weekStart crosses a month boundary', () => {
  // Tuesday 1 September 2026 belongs to the week beginning 31 August.
  assert.equal(weekStart(new Date('2026-09-01T10:00').getTime()), '2026-08-31')
})

test('selectThisWeek runs Monday to now, with no upper bound', () => {
  const selected = selectThisWeek(
    [
      trade('2026-07-26T15:30'), // Sunday — previous week
      trade('2026-07-27T09:00'), // Monday — boundary, included
      trade('2026-07-30T15:30'),
      trade('2026-07-31T15:30'), // ahead of today, still this week
    ],
    NOW
  )

  assert.deepEqual(
    selected.map((t) => t.id),
    ['2026-07-27T09:00', '2026-07-30T15:30', '2026-07-31T15:30']
  )
})

test('trades with no date are excluded rather than throwing', () => {
  const trades = [{ id: 'a' }, { id: 'b', date: null }, trade('2026-07-30T15:30')]

  assert.equal(selectToday(trades, NOW).length, 1)
  assert.equal(selectThisWeek(trades, NOW).length, 1)
})

test('an empty selection selects nothing, quietly', () => {
  assert.deepEqual(selectToday([], NOW), [])
  assert.deepEqual(selectThisWeek([], NOW), [])
})

// --- describeScope --------------------------------------------------------

test('describeScope names the count and the range', () => {
  assert.equal(
    describeScope([trade('2026-07-27T09:00'), trade('2026-07-30T15:30')]),
    '2 trades · 2026-07-27 → 2026-07-30'
  )
})

test('describeScope collapses a single day and singularises one trade', () => {
  assert.equal(describeScope([trade('2026-07-30T15:30')]), '1 trade · 2026-07-30')
  assert.equal(
    describeScope([trade('2026-07-30T09:00'), trade('2026-07-30T15:30')]),
    '2 trades · 2026-07-30'
  )
})

test('describeScope reports the range regardless of input order', () => {
  const unordered = [
    trade('2026-07-30T15:30'),
    trade('2026-07-27T09:00'),
    trade('2026-07-29T11:00'),
  ]
  assert.equal(describeScope(unordered), '3 trades · 2026-07-27 → 2026-07-30')
})

test('describeScope degrades to a bare count without dates', () => {
  assert.equal(describeScope([{ id: 'a' }, { id: 'b' }]), '2 trades')
  assert.equal(describeScope([]), '0 trades')
})
