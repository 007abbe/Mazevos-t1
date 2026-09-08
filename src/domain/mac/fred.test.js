import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  annualised3m,
  changeOver,
  changeOverBps,
  daysBetween,
  isStale,
  lastValue,
  meanOfLast,
  monthsBackPair,
  nBack,
  parseObservations,
  pctChangeOver,
  realisedVol,
  realisedVolSeries,
  yoy,
  zScore,
} from './fred.js'

/** A series from `[date, value]` pairs. */
const series = (...rows) => rows.map(([date, value]) => ({ date, value }))

/** `n` daily observations starting at 2026-01-01, from a value function. */
const daily = (n, value) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    value: value(i),
  }))

test('parseObservations drops FRED missing markers', () => {
  const parsed = parseObservations({
    observations: [
      { date: '2026-01-01', value: '1.5' },
      { date: '2026-01-02', value: '.' },
      { date: '2026-01-03', value: '2.5' },
    ],
  })

  assert.deepEqual(parsed, series(['2026-01-01', 1.5], ['2026-01-03', 2.5]))
})

test('parseObservations sorts ascending and survives a malformed payload', () => {
  const parsed = parseObservations({
    observations: [
      { date: '2026-01-03', value: '3' },
      { date: '2026-01-01', value: '1' },
    ],
  })

  assert.deepEqual(
    parsed.map((r) => r.date),
    ['2026-01-01', '2026-01-03']
  )
  assert.deepEqual(parseObservations(null), [])
  assert.deepEqual(parseObservations({ observations: 'nope' }), [])
  assert.deepEqual(parseObservations({ observations: [{ date: '2026-01-01', value: 'n/a' }] }), [])
})

test('nBack counts observations, not calendar days', () => {
  // A gap across a long weekend: five rows spanning eight calendar days.
  const rows = series(
    ['2026-01-01', 1],
    ['2026-01-02', 2],
    ['2026-01-06', 3],
    ['2026-01-07', 4],
    ['2026-01-08', 5]
  )

  assert.equal(nBack(rows, 4).date, '2026-01-01')
  assert.equal(changeOver(rows, 4), 4)
})

test('a change over more observations than exist is null, never clamped', () => {
  const rows = series(['2026-01-01', 1], ['2026-01-02', 2])

  assert.equal(changeOver(rows, 20), null)
  assert.equal(pctChangeOver(rows, 20), null)
  assert.equal(nBack(rows, 5), null)
  assert.equal(changeOver([], 1), null)
})

test('changeOverBps converts a percent series to basis points', () => {
  const rows = series(['2026-01-01', 3.5], ['2026-01-02', 3.77])
  assert.equal(Math.round(changeOverBps(rows, 1)), 27)
})

test('pctChangeOver is a percentage and guards a zero base', () => {
  assert.equal(pctChangeOver(series(['a', 100], ['b', 101.5]), 1), 1.5)
  assert.equal(pctChangeOver(series(['a', 0], ['b', 5]), 1), null)
})

test('meanOfLast refuses a window longer than the series', () => {
  const rows = series(['a', 10], ['b', 20], ['c', 30], ['d', 40])

  assert.equal(meanOfLast(rows, 4), 25)
  assert.equal(meanOfLast(rows, 2), 35)
  assert.equal(meanOfLast(rows, 13), null)
})

test('monthsBackPair matches on the calendar month, not the row count', () => {
  // A monthly series with one publication skipped: row counting would land on
  // the wrong month.
  const rows = series(
    ['2025-09-01', 100],
    ['2025-10-01', 101],
    ['2025-12-01', 103],
    ['2026-01-01', 104]
  )

  assert.deepEqual(monthsBackPair(rows, 3), { now: 104, then: 101 })
  assert.equal(monthsBackPair(rows, 6), null)
  assert.equal(monthsBackPair([], 3), null)
})

test('yoy is the twelve-month percentage change', () => {
  const rows = [
    { date: '2025-01-01', value: 100 },
    ...Array.from({ length: 11 }, (_, i) => ({
      date: `2025-${String(i + 2).padStart(2, '0')}-01`,
      value: 100,
    })),
    { date: '2026-01-01', value: 103.4 },
  ]

  assert.equal(Number(yoy(rows).toFixed(2)), 3.4)
})

test('annualised3m compounds the three-month change to a yearly rate', () => {
  const rows = series(['2025-10-01', 100], ['2025-11-01', 100], ['2025-12-01', 100], ['2026-01-01', 101])

  // 1% over a quarter compounds to just over 4% a year.
  assert.equal(Number(annualised3m(rows).toFixed(2)), 4.06)
  assert.equal(annualised3m(series(['2026-01-01', 100])), null)
})

test('annualised3m leads yoy at a turn, which is what F2 reads', () => {
  // Flat for a year, then three hot months. YoY barely moves; 3m annualised
  // jumps — the whole point of comparing the two.
  const flat = Array.from({ length: 12 }, (_, i) => ({
    date: `2025-${String(i + 1).padStart(2, '0')}-01`,
    value: 100,
  }))
  const hot = [
    { date: '2025-11-01', value: 100.5 },
    { date: '2025-12-01', value: 101 },
    { date: '2026-01-01', value: 101.5 },
  ]
  const rows = [...flat.slice(0, 10), ...hot]

  assert.ok(annualised3m(rows) > yoy(rows))
})

test('realisedVol needs n+1 closes and annualises by root 252', () => {
  const flat = daily(21, () => 100)
  assert.equal(realisedVol(flat, 20), 0)
  assert.equal(realisedVol(daily(20, () => 100), 20), null)

  // A constant 1% daily alternation has a real, positive realised vol.
  const wobble = daily(21, (i) => (i % 2 === 0 ? 100 : 101))
  assert.ok(realisedVol(wobble, 20) > 10)
})

test('realisedVolSeries yields one point per computable day', () => {
  const rows = daily(25, (i) => 100 + (i % 2))
  const rv = realisedVolSeries(rows, 20)

  assert.equal(rv.length, 25 - 20)
  assert.equal(rv[rv.length - 1].date, rows[rows.length - 1].date)
})

test('zScore refuses a sample too small to mean anything', () => {
  const short = daily(20, (i) => i)
  assert.equal(zScore(short, 252, 30), null)

  const long = daily(60, (i) => (i === 59 ? 100 : 10))
  assert.ok(zScore(long, 252, 30) > 2)

  assert.equal(zScore(daily(60, () => 5), 252, 30), null, 'a flat series has no z-score')
})

test('daysBetween is signed and rejects nonsense dates', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-08'), 7)
  assert.equal(daysBetween('2026-09-08', '2026-09-01'), -7)
  assert.equal(daysBetween('not-a-date', '2026-09-01'), null)
})

test('isStale compares the latest observation to its cadence budget', () => {
  const rows = series(['2026-09-01', 1])

  assert.equal(isStale(rows, '2026-09-05', 7), false)
  assert.equal(isStale(rows, '2026-09-30', 7), true)
  assert.equal(isStale([], '2026-09-05', 7), true, 'an empty series is stale, not fresh')
})

test('lastValue reads the newest observation', () => {
  assert.equal(lastValue(series(['a', 1], ['b', 2])), 2)
  assert.equal(lastValue([]), null)
})
