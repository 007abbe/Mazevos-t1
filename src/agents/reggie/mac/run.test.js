import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SERIES } from '../../../domain/mac/factors.js'
import { runMac } from './run.js'

/** 2026-09-08 08:00 ET — a Tuesday. */
const NOW = Date.parse('2026-09-08T08:00:00-04:00')

const daily = (n, value, end = '2026-09-08') => {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(endMs - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
    value,
  }))
}

const series = () => ({
  [SERIES.VIXCLS.id]: daily(30, 15),
  [SERIES.VXVCLS.id]: daily(30, 17),
  [SERIES.DGS2.id]: daily(40, 3.9),
})

const CALENDAR = [
  {
    title: 'CPI m/m',
    country: 'USD',
    impact: 'High',
    date: '2026-09-08T08:30:00-04:00',
    forecast: '0.3%',
    previous: '0.2%',
  },
]

const deps = (overrides = {}) => {
  const saved = []
  return {
    saved,
    deps: {
      fetchSeries: async () => ({ series: series(), failed: {} }),
      fetchCalendar: async () => ({ events: CALENDAR }),
      priorSnapshot: async () => null,
      saveSnapshot: async (snapshot) => {
        saved.push(snapshot)
      },
      ...overrides,
    },
  }
}

test('runMac fetches, computes and stores in order', async () => {
  const steps = []
  const { deps: d, saved } = deps()

  const result = await runMac(
    { now: NOW },
    { ...d, onProgress: (step) => steps.push(step) }
  )

  assert.deepEqual(steps, [
    'Fetching FRED series…',
    'Fetching calendar…',
    'Reading yesterday…',
    'Computing factors…',
  ])
  assert.equal(result.snapshot.date, '2026-09-08')
  assert.equal(result.saved, true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0], result.snapshot)
})

test('the calendar types the day and caps size', async () => {
  const { deps: d } = deps()
  const { snapshot } = await runMac({ now: NOW }, d)

  assert.equal(snapshot.l2.day_type, 'tier1_event')
  assert.equal(snapshot.l2.size_cap, 0.5)
  assert.deepEqual(snapshot.l2.no_trade_windows, [
    { from: '08:30', to: '08:35', why: 'CPI m/m — release' },
  ])
})

test('a failed calendar degrades to vol-only rather than failing the run', async () => {
  const { deps: d } = deps({
    fetchCalendar: async () => {
      throw new Error('Calendar unavailable')
    },
  })

  const result = await runMac({ now: NOW }, d)

  assert.ok(result.calendarError, 'the caller is told')
  assert.equal(result.snapshot.l2.day_type, null, 'untyped, not "normal"')
  assert.ok(result.snapshot.data_health.missing.includes('CALENDAR'))
  assert.equal(result.saved, true, 'the factor read is still worth storing')
})

test('a failed save does not lose the snapshot', async () => {
  const { deps: d } = deps({
    saveSnapshot: async () => {
      throw new Error('offline')
    },
  })

  const result = await runMac({ now: NOW }, d)

  assert.equal(result.saved, false)
  assert.match(result.saveError.message, /offline/)
  assert.ok(result.snapshot.l1.bar.bull_pct, 'the numbers survive the failed write')
})

test('yesterday’s snapshot is threaded into the hysteresis', async () => {
  const prior = {
    date: '2026-09-05',
    l1: {
      bar: { history_10: [44, 42] },
      regime: { label: 'neutral', since: '2026-09-01' },
      factors: { credit: { memory: { state: -2, speed: true } } },
    },
  }

  const { deps: d } = deps({ priorSnapshot: async () => prior })
  const { snapshot } = await runMac({ now: NOW }, d)

  assert.equal(snapshot.l1.bar.history_10.length, 3, 'today is appended to yesterday’s')
  assert.equal(snapshot.l1.factors.credit.state, -2, 'a carried state survives the round trip')
})

test('the harvested ISM print reaches the snapshot', async () => {
  const { deps: d } = deps({
    fetchIsmActuals: async () => [
      { date: '2026-09-01', value: 49.1, source: 'forexfactory-actual' },
    ],
  })
  const { snapshot } = await runMac({ now: NOW }, d)

  assert.equal(snapshot.l1.factors.growth.inputs.pmi, 49.1)
  assert.equal(snapshot.l1.factors.growth.pmi_source, 'forexfactory-actual')
})

test('a failed ISM harvest does not stop the snapshot', async () => {
  // `fetchIsmActuals` swallows its own errors, so the pipeline sees an empty
  // list. F1 then falls back to whatever the feed's `previous` gave it, which
  // is where mac was before the scraper existed.
  const { deps: d } = deps({ fetchIsmActuals: async () => [] })
  const { snapshot } = await runMac({ now: NOW }, d)

  assert.ok(snapshot.l1.factors.growth)
})

test('failed series are reported, not silently dropped', async () => {
  const { deps: d } = deps({
    fetchSeries: async () => ({ series: {}, failed: { DGS2: 'FRED 400' } }),
  })

  const result = await runMac({ now: NOW }, d)

  assert.deepEqual(result.failed, { DGS2: 'FRED 400' })
  assert.ok(result.snapshot.data_health.missing.length > 0)
})
