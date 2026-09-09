import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractDays,
  ismActuals,
  mergeActuals,
  monthUrl,
  monthsToFetch,
  harvestHealth,
} from './ff-actuals.js'

/** 2026-09-01, 10:00 New York — where ISM manufacturing actually lands. */
const SEP_RELEASE = 1788271200
const AUG_31_RELEASE = SEP_RELEASE - 86400

const event = (over = {}) => ({
  name: 'ISM Manufacturing PMI',
  currency: 'USD',
  dateline: SEP_RELEASE,
  actual: '54.6',
  forecast: '55.2',
  previous: '55.6',
  ...over,
})

/** The shape the real page has: a JS object literal whose `days` is JSON. */
const page = (events) => `
  <script>window.calendarComponentStates[1] = {
  days: ${JSON.stringify([{ date: 'Tue <span>Sep 1</span>', events }])},
  stateId: 1
  };</script>
`

test('monthUrl builds the slug ForexFactory expects', () => {
  assert.equal(monthUrl('2026-09'), 'https://www.forexfactory.com/calendar?month=sep.2026')
  assert.equal(monthUrl('2026-01'), 'https://www.forexfactory.com/calendar?month=jan.2026')
  assert.throws(() => monthUrl('2026-13'))
})

test('extractDays returns null rather than guessing at an unexpected page', () => {
  // A Cloudflare interstitial, an error page and a rewritten template all land
  // here, and all three must degrade to "no harvest" rather than to a throw.
  assert.equal(extractDays('<html>Just a moment...</html>'), null)
  assert.equal(extractDays(''), null)
  assert.equal(extractDays(null), null)
  assert.equal(extractDays('window.calendarComponentStates[1] = { days: [ broken'), null)
})

test('extractDays is not fooled by a bracket inside an event title', () => {
  // The reason the extractor scans instead of matching a regex: a title like
  // this closes the array early for anything that ignores string context.
  const days = extractDays(page([event({ name: 'ISM Manufacturing PMI [revised]' })]))
  assert.equal(days.length, 1)
  assert.equal(days[0].events[0].name, 'ISM Manufacturing PMI [revised]')
})

test('a release is dated to the month it reports, not the month it prints', () => {
  const { entries } = ismActuals(page([event()]), { month: '2026-09' })

  assert.deepEqual(entries, [
    {
      date: '2026-08-01',
      value: 54.6,
      release_date: '2026-09-01',
      source: 'forexfactory-actual',
    },
  ])
})

test('an unreleased row yields nothing — the forecast is never substituted', () => {
  const { entries } = ismActuals(page([event({ actual: '' })]), { month: '2026-09' })
  assert.deepEqual(entries, [])
})

test('only USD manufacturing counts', () => {
  const { entries } = ismActuals(
    page([
      event({ name: 'ISM Services PMI', actual: '55.4' }),
      event({ name: 'ISM Manufacturing Prices', actual: '71.1' }),
      event({ currency: 'GBP', actual: '48.0' }),
    ]),
    { month: '2026-09' }
  )

  assert.deepEqual(entries, [])
})

test('a row from a neighbouring month is dropped', () => {
  // Dating an August release as if it were the September one would shift the
  // print a month and silently corrupt the three-month average.
  const { entries } = ismActuals(page([event({ dateline: AUG_31_RELEASE })]), {
    month: '2026-09',
  })

  assert.deepEqual(entries, [])
})

test('a malformed page reports the reason instead of failing silently', () => {
  const result = ismActuals('<html>Just a moment...</html>', { month: '2026-09' })
  assert.deepEqual(result.entries, [])
  assert.match(result.error, /no calendar state/)
})

test('mergeActuals lets a later scrape carry a revision', () => {
  const merged = mergeActuals(
    [{ date: '2026-08-01', value: 54.6, source: 'forexfactory-actual' }],
    [{ date: '2026-08-01', value: 54.8, source: 'forexfactory-actual' }]
  )

  assert.deepEqual(merged, [{ date: '2026-08-01', value: 54.8, source: 'forexfactory-actual' }])
})

test('mergeActuals drops entries with no usable value', () => {
  const merged = mergeActuals([{ date: '2026-08-01', value: null }], [{ value: 54.6 }])
  assert.deepEqual(merged, [])
})

test('monthsToFetch always asks for the current month', () => {
  const complete = [
    { date: '2026-08-01' },
    { date: '2026-07-01' },
    { date: '2026-06-01' },
  ]

  // Everything else is on file, so a routine run costs exactly one request —
  // the month a new print would appear in.
  assert.deepEqual(monthsToFetch(complete, '2026-09-09', 3), ['2026-09'])
})

test('monthsToFetch backfills only the months it is missing', () => {
  // The July print is on file, and the page that carries it is August's — so
  // August is the request that gets skipped, not July's.
  assert.deepEqual(monthsToFetch([{ date: '2026-07-01' }], '2026-09-09', 3), [
    '2026-09',
    '2026-07',
  ])

  assert.deepEqual(monthsToFetch([], '2026-09-09', 3, 3), ['2026-09', '2026-08', '2026-07'])
})

test('monthsToFetch never asks for more pages than the limit allows', () => {
  // A burst is what gets the current month refused, so an empty file backfills
  // across runs rather than in one go.
  assert.deepEqual(monthsToFetch([], '2026-09-09', 6), ['2026-09', '2026-08'])
})

test('monthsToFetch crosses a year boundary', () => {
  assert.deepEqual(monthsToFetch([], '2027-01-04', 2), ['2027-01', '2026-12'])
})

test('harvestHealth stays quiet early in the month', () => {
  // ISM has not printed yet on the 3rd of a month with a weekend in it, and a
  // warning here would fire every month by design.
  const health = harvestHealth([{ date: '2026-07-01' }], '2026-09-03')
  assert.equal(health.stale, false)
  assert.equal(health.expected, null)
})

test('harvestHealth notices a harvest that has stopped', () => {
  const health = harvestHealth([{ date: '2026-07-01' }], '2026-09-20')
  assert.equal(health.stale, true)
  assert.equal(health.expected, '2026-08-01')
  assert.equal(health.latest, '2026-07-01')
})

test('harvestHealth is satisfied by the previous month', () => {
  const health = harvestHealth(
    [{ date: '2026-07-01' }, { date: '2026-08-01' }],
    '2026-09-20'
  )
  assert.equal(health.stale, false)
})

test('harvestHealth treats an empty file as stale once the grace period passes', () => {
  assert.equal(harvestHealth([], '2026-09-20').stale, true)
  assert.equal(harvestHealth(null, '2026-09-02').stale, false)
})
