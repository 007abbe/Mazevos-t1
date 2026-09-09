import test from 'node:test'
import assert from 'node:assert/strict'

import { asOfSeries, closesByDate, seriesAsOf, sessionDates } from './vintage.js'

const row = (date, value, start, end = '9999-12-31') => ({
  date,
  value: String(value),
  realtime_start: start,
  realtime_end: end,
})

test('an observation is invisible before it is published', () => {
  // August CPI carries an August observation date but is not released until
  // September. Filtering on the observation date alone is the single most
  // effective way to make a macro backtest lie.
  const rows = [row('2026-08-01', 3.1, '2026-09-10')]

  assert.deepEqual(asOfSeries(rows, '2026-09-09'), [])
  assert.deepEqual(asOfSeries(rows, '2026-09-10'), [{ date: '2026-08-01', value: 3.1 }])
})

test('a revision is invisible until it lands', () => {
  const rows = [
    row('2026-06-01', 2.0, '2026-07-30', '2026-08-28'),
    row('2026-06-01', 2.6, '2026-08-29'),
  ]

  assert.equal(asOfSeries(rows, '2026-08-01')[0].value, 2.0, 'the first estimate')
  assert.equal(asOfSeries(rows, '2026-09-01')[0].value, 2.6, 'the revision, once published')
})

test('the latest vintage wins when the payload leaves realtime_end open', () => {
  // ALFRED sometimes returns overlapping open-ended windows. Taking whichever
  // arrived last in the array would make the result depend on FRED's ordering.
  const rows = [
    { date: '2026-06-01', value: '2.6', realtime_start: '2026-08-29' },
    { date: '2026-06-01', value: '2.0', realtime_start: '2026-07-30' },
  ]

  assert.equal(asOfSeries(rows, '2026-09-01')[0].value, 2.6)
})

test('missing observations are dropped, never carried as zero', () => {
  const rows = [row('2026-06-01', 2.0, '2026-06-02'), row('2026-06-02', '.', '2026-06-03')]

  assert.deepEqual(asOfSeries(rows, '2026-07-01'), [{ date: '2026-06-01', value: 2.0 }])
})

test('the series comes back ascending, whatever order it arrived in', () => {
  const rows = [
    row('2026-06-03', 3, '2026-06-04'),
    row('2026-06-01', 1, '2026-06-02'),
    row('2026-06-02', 2, '2026-06-03'),
  ]

  assert.deepEqual(
    asOfSeries(rows, '2026-07-01').map((r) => r.value),
    [1, 2, 3]
  )
})

test('seriesAsOf applies the same cut to every series', () => {
  const store = {
    VIXCLS: [row('2026-06-01', 15, '2026-06-02')],
    DGS2: [row('2026-06-01', 3.9, '2026-07-01')],
  }

  const asOf = seriesAsOf(store, '2026-06-15')
  assert.equal(asOf.VIXCLS.length, 1)
  assert.equal(asOf.DGS2.length, 0, 'not yet published on the 15th')
})

test('sessionDates are the days the index actually traded', () => {
  const rows = [
    row('2026-06-01', 100, '2026-06-02'),
    row('2026-06-02', '.', '2026-06-03'), // a holiday
    row('2026-06-03', 102, '2026-06-04'),
    row('2026-07-01', 105, '2026-07-02'), // outside the window
  ]

  assert.deepEqual(sessionDates(rows, '2026-06-01', '2026-06-30'), ['2026-06-01', '2026-06-03'])
})

test('closesByDate reads the final value, not the point-in-time one', () => {
  // The outcome is not an input to the decision, so it is not filtered by
  // vintage. If it were, a publication lag would shift every return by a day.
  const rows = [
    row('2026-06-01', 100, '2026-06-02', '2026-06-09'),
    row('2026-06-01', 101, '2026-06-10'),
  ]

  assert.equal(closesByDate(rows).get('2026-06-01'), 101)
})

test('the session being scored is never visible to the model that scores it', () => {
  // mac runs pre-market. FRED stamps some daily series as available the same
  // day, so the realtime bounds alone would hand Monday's close to Monday's
  // 8am run — a small leak that points the right way on precisely the days
  // that decide the result.
  const rows = [
    row('2026-06-01', 100, '2026-06-01'),
    row('2026-06-02', 101, '2026-06-02'),
  ]

  assert.deepEqual(asOfSeries(rows, '2026-06-02'), [{ date: '2026-06-01', value: 100 }])
})
