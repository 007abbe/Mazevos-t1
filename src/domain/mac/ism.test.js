import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  harvestIsm,
  ismRows,
  mergeIsmHistory,
  parseLevel,
  previousMonthOf,
} from './ism.js'

const ismRow = (date, { forecast = '', previous = '' } = {}) => ({
  title: 'ISM Manufacturing PMI',
  country: 'USD',
  impact: 'High',
  date,
  forecast,
  previous,
})

test('parseLevel reads FF’s decorated strings', () => {
  assert.equal(parseLevel('49.1'), 49.1)
  assert.equal(parseLevel('49.1%'), 49.1)
  assert.equal(parseLevel(48), 48)
  assert.equal(parseLevel(''), null)
  assert.equal(parseLevel(null), null)
  assert.equal(parseLevel('n/a'), null)
})

test('previousMonthOf dates a harvested value two months before its release', () => {
  // The 1 October release reports September; its `previous` is August.
  assert.equal(previousMonthOf('2026-10-01'), '2026-08-01')
  assert.equal(previousMonthOf('2026-01-02'), '2025-11-01', 'across a year boundary')
})

test('ismRows matches manufacturing only, newest first', () => {
  const calendar = [
    ismRow('2026-09-01T10:00:00-04:00', { previous: '48.7' }),
    { ...ismRow('2026-09-03T10:00:00-04:00'), title: 'ISM Services PMI', previous: '52.1' },
    ismRow('2026-10-01T10:00:00-04:00', { previous: '49.1' }),
  ]

  const rows = ismRows(calendar)
  assert.equal(rows.length, 2, 'Services is a different series and must not interleave')
  assert.equal(rows[0].releaseDate, '2026-10-01')
})

test('harvestIsm turns a release row’s previous into a dated history entry', () => {
  const harvested = harvestIsm([ismRow('2026-10-01T10:00:00-04:00', { previous: '49.1' })])

  assert.deepEqual(harvested, { value: 49.1, date: '2026-08-01', source: 'forexfactory' })
})

test('harvestIsm returns null in the weeks with no ISM row', () => {
  assert.equal(harvestIsm([]), null)
  assert.equal(harvestIsm(null), null)
  assert.equal(harvestIsm([ismRow('2026-10-01T10:00:00-04:00', { forecast: '49.5' })]), null)
})

test('a typed value outranks a harvested one for the same month', () => {
  const merged = mergeIsmHistory(
    [{ date: '2026-08-01', value: 49.0 }],
    [{ date: '2026-08-01', value: 49.1, source: 'forexfactory' }]
  )

  assert.deepEqual(merged, [{ date: '2026-08-01', value: 49.0 }])
})

test('a harvest fills months that were never typed', () => {
  const merged = mergeIsmHistory(
    [{ date: '2026-09-01', value: 50.2 }],
    [
      { date: '2026-07-01', value: 48.4, source: 'forexfactory' },
      { date: '2026-08-01', value: 49.1, source: 'forexfactory' },
    ]
  )

  assert.deepEqual(
    merged.map((r) => r.date),
    ['2026-07-01', '2026-08-01', '2026-09-01']
  )
  assert.equal(merged[2].source, undefined, 'the typed entry stays typed')
})

test('mergeIsmHistory drops malformed entries from either side', () => {
  const merged = mergeIsmHistory(
    [{ date: '2026-08-01', value: NaN }, { value: 50 }, null],
    [{ date: '2026-07-01', value: 48.4, source: 'forexfactory' }]
  )

  assert.deepEqual(merged, [{ date: '2026-07-01', value: 48.4, source: 'forexfactory' }])
})

test('harvesting is idempotent across repeated runs', () => {
  const harvested = [{ date: '2026-08-01', value: 49.1, source: 'forexfactory' }]
  let history = []

  for (let i = 0; i < 5; i += 1) history = mergeIsmHistory(history, harvested)

  assert.equal(history.length, 1)
})
