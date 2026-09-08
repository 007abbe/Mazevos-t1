import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SERIES } from './factors.js'
import { FACTOR_KEYS } from './compose.js'
import { SNAPSHOT_VERSION, buildSnapshot, dataHealth, isHealthy, resolvePmi } from './snapshot.js'

const TODAY = '2026-09-08'

const daily = (n, value, end = TODAY) => {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(endMs - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
    value: value(i, n),
  }))
}

const weekly = (n, value, end = TODAY) => {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(endMs - (n - 1 - i) * 7 * 86400000).toISOString().slice(0, 10),
    value: value(i, n),
  }))
}

const monthly = (n, value, endYear = 2026, endMonth = 8) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(endYear, endMonth - 1 - (n - 1 - i), 1)).toISOString().slice(0, 10),
    value: value(i, n),
  }))

/**
 * A core-inflation index at `yoyPct` year-over-year, decelerating to `recentPct`
 * over the last quarter. Pins the three points F2 actually reads.
 */
function inflation(yoyPct, recentPct) {
  const values = new Array(13)
  values[0] = 100
  values[12] = 100 * (1 + yoyPct / 100)
  values[9] = values[12] / Math.pow(1 + recentPct / 100, 1 / 4)

  const fill = (from, to) => {
    for (let i = from + 1; i < to; i += 1) {
      values[i] = values[from] + ((values[to] - values[from]) * (i - from)) / (to - from)
    }
  }
  fill(0, 9)
  fill(9, 12)

  return monthly(13, (i) => values[i])
}

/**
 * A complete, healthy, uneventful set of series — every factor reads zero.
 *
 * Inflation is decelerating at 3.2%, which is the honest way to score zero: it
 * is inside neither the sub-3.0 tailwind nor the above-3.5 headwind. Making the
 * 3-month rate exactly equal to YoY would score zero too, but only by landing
 * on a floating-point knife edge that no real series ever sits on.
 */
function quietSeries() {
  return {
    [SERIES.GDPNOW.id]: daily(5, () => 2.0),
    [SERIES.ICSA.id]: weekly(20, () => 230000),
    [SERIES.CPILFESL.id]: inflation(3.2, 2.9),
    [SERIES.PCEPILFE.id]: inflation(3.2, 2.9),
    [SERIES.DFEDTARU.id]: daily(220, () => 4.5),
    [SERIES.DGS2.id]: daily(40, () => 3.9),
    [SERIES.DGS10.id]: daily(40, () => 4.2),
    [SERIES.DFII10.id]: daily(40, () => 1.8),
    [SERIES.WALCL.id]: weekly(12, () => 7000 * 1000),
    [SERIES.WTREGEN.id]: weekly(12, () => 700),
    [SERIES.RRPONTSYD.id]: weekly(12, () => 300),
    [SERIES.BAMLH0A0HYM2.id]: daily(30, () => 2.8),
    [SERIES.BAMLC0A0CM.id]: daily(30, () => 1.05),
    [SERIES.DTWEXBGS.id]: daily(30, () => 100),
    [SERIES.DEXJPUS.id]: daily(30, () => 148),
    [SERIES.VIXCLS.id]: daily(30, () => 15),
    [SERIES.VXVCLS.id]: daily(30, () => 17),
    [SERIES.NASDAQ100.id]: daily(300, () => 20000),
  }
}

const build = (overrides = {}) =>
  buildSnapshot({
    series: quietSeries(),
    today: TODAY,
    computedAt: '2026-09-08T09:30:00.000Z',
    ...overrides,
  })

test('the snapshot matches the v0.1 shape', () => {
  const snapshot = build()

  assert.equal(snapshot.date, TODAY)
  assert.equal(snapshot.version, SNAPSHOT_VERSION)
  assert.equal(snapshot.computed_at, '2026-09-08T09:30:00.000Z')

  for (const key of ['l1', 'l2', 'l3_baselines', 'data_health']) {
    assert.ok(snapshot[key], `missing ${key}`)
  }
  for (const key of ['quadrant', 'bias_raw', 'conviction', 'bar', 'factors', 'headwinds', 'tailwinds', 'watch']) {
    assert.ok(key in snapshot.l1, `missing l1.${key}`)
  }
  for (const key of FACTOR_KEYS) {
    const factor = snapshot.l1.factors[key]
    assert.ok(factor, `missing factor ${key}`)
    for (const field of ['state', 'inputs', 'note', 'flip', 'memory', 'carried']) {
      assert.ok(field in factor, `factor ${key} missing ${field}`)
    }
  }
})

test('the snapshot round-trips through JSON without losing its memory', () => {
  const snapshot = build()
  const revived = JSON.parse(JSON.stringify(snapshot))

  assert.deepEqual(revived, snapshot)

  // And a second day computed from the revived copy still sees yesterday.
  const next = build({ prior: revived })
  assert.equal(next.l1.bar.history_10.length, 2)
})

test('a quiet tape composes to neutral with a calm vol regime', () => {
  const snapshot = build()

  assert.equal(snapshot.l1.bias_raw, 0)
  assert.equal(snapshot.l1.bar.bull_pct, 50)
  assert.equal(snapshot.l1.bar.label, 'neutral')
  assert.equal(snapshot.l2.vol_regime, 'calm')
  assert.equal(snapshot.l2.size_cap, 1)
})

test('data_health names the missing ISM and the missing z-score inputs', () => {
  const series = quietSeries()
  delete series[SERIES.NASDAQ100.id]

  const snapshot = buildSnapshot({ series, today: TODAY })

  assert.ok(snapshot.data_health.missing.includes('ISM_PMI'), 'ISM is never silently absent')
  assert.ok(
    snapshot.data_health.missing.includes(SERIES.NASDAQ100.id),
    'a disabled third of the vol classifier is reported, not just nulled'
  )
  assert.equal(snapshot.l2.rv20_z, null)
  assert.equal(isHealthy(snapshot), false)
})

test('a stale input lands in data_health and marks its factor carried', () => {
  const series = quietSeries()
  series[SERIES.BAMLH0A0HYM2.id] = daily(30, () => 5.2, '2026-06-01')

  const snapshot = buildSnapshot({
    series,
    prior: { l1: { factors: { credit: { memory: { state: -2 } } } } },
    today: TODAY,
  })

  assert.ok(snapshot.data_health.stale.includes(SERIES.BAMLH0A0HYM2.id))
  assert.ok(snapshot.data_health.carried.includes('credit'))
  assert.equal(snapshot.l1.factors.credit.state, -2, 'yesterday’s state, not a fresh zero')
  assert.equal(snapshot.l1.factors.credit.carried, true)
})

test('data_health deduplicates an input two factors both read', () => {
  const health = dataHealth(
    {
      growth: { missing: ['ICSA'], stale: [], carried: true },
      inflation: { missing: ['ICSA'], stale: ['DGS2'], carried: false },
      rates: { missing: [], stale: ['DGS2'], carried: false },
      liquidity: { missing: [], stale: [], carried: false },
      credit: { missing: [], stale: [], carried: false },
      dollar: { missing: [], stale: [], carried: false },
    },
    { missing: [], stale: [], carried: false }
  )

  assert.deepEqual(health.missing, ['ICSA'])
  assert.deepEqual(health.stale, ['DGS2'])
  assert.deepEqual(health.carried, ['growth'])
})

test('history_10 keeps at most ten readings, oldest first', () => {
  let snapshot = null
  for (let i = 0; i < 14; i += 1) snapshot = build({ prior: snapshot })

  assert.equal(snapshot.l1.bar.history_10.length, 10)
  assert.equal(snapshot.l1.bar.history_10[9], snapshot.l1.bar.bull_pct)
})

test('l3_baselines carries today’s closes for the live-tells card', () => {
  const snapshot = build()

  assert.deepEqual(snapshot.l3_baselines, { dgs2: 3.9, dxy: 100, usdjpy: 148 })
})

test('l2 reports a vol-only size cap and says day typing is not done yet', () => {
  const series = quietSeries()
  series[SERIES.VIXCLS.id] = daily(30, () => 34)

  const snapshot = buildSnapshot({ series, today: TODAY })

  assert.equal(snapshot.l2.vol_regime, 'hostile')
  assert.equal(snapshot.l2.size_cap, 0.5)
  assert.equal(snapshot.l2.spm_allowed, false)
  assert.equal(snapshot.l2.mm_preferred, true)
  assert.equal(snapshot.l2.day_type, null, 'null, not a "normal" nobody checked')
  assert.deepEqual(snapshot.l2.events_next_5, [])
})

test('the vol regime feeds both the multiplier and the conviction notch', () => {
  const series = quietSeries()
  // Five factors leaning bearish.
  series[SERIES.CPILFESL.id] = monthly(13, (i) => (i < 10 ? 100 + i * 0.3 : 103 + (i - 9) * 0.6))
  series[SERIES.PCEPILFE.id] = series[SERIES.CPILFESL.id]

  const calm = buildSnapshot({ series, today: TODAY })
  const hostile = buildSnapshot({
    series: { ...series, [SERIES.VIXCLS.id]: daily(30, () => 34) },
    today: TODAY,
  })

  assert.ok(hostile.l1.bar.bull_pct > calm.l1.bar.bull_pct, 'hostile pulls the bar toward 50')
})

test('resolvePmi carries the last print forward and keeps a history', () => {
  const first = resolvePmi(null, { value: 49.1, date: '2026-09-01' })
  assert.equal(first.value, 49.1)
  assert.equal(first.history.length, 1)

  const prior = { l1: { factors: { growth: { pmi_history: first.history } } } }

  // No new entry: the September print still stands.
  const carried = resolvePmi(prior, null)
  assert.equal(carried.value, 49.1)
  assert.equal(carried.date, '2026-09-01')

  const next = resolvePmi(prior, { value: 51.4, date: '2026-10-01' })
  assert.equal(next.value, 51.4)
  assert.equal(next.history.length, 2)
})

test('resolvePmi corrects a revision in place rather than double-counting it', () => {
  const first = resolvePmi(null, { value: 49.1, date: '2026-09-01' })
  const prior = { l1: { factors: { growth: { pmi_history: first.history } } } }
  const revised = resolvePmi(prior, { value: 49.6, date: '2026-09-01' })

  assert.equal(revised.history.length, 1)
  assert.equal(revised.value, 49.6)
})

test('resolvePmi ignores an entry with no usable value', () => {
  assert.deepEqual(resolvePmi(null, { value: NaN, date: '2026-09-01' }).history, [])
  assert.deepEqual(resolvePmi(null, { value: 49, date: null }).history, [])
})

test('the PMI history lives inside the growth factor so one row carries it all', () => {
  const snapshot = build({ pmiEntry: { value: 49.1, date: '2026-09-01' } })

  assert.deepEqual(snapshot.l1.factors.growth.pmi_history, [{ date: '2026-09-01', value: 49.1 }])
  assert.equal(snapshot.l1.factors.growth.inputs.pmi, 49.1)

  // The next day reads it back without the entry being typed again.
  const next = build({ prior: snapshot })
  assert.equal(next.l1.factors.growth.inputs.pmi, 49.1)
})

test('a run with no prior snapshot does not throw', () => {
  assert.doesNotThrow(() => buildSnapshot({ series: {}, today: TODAY }))

  const empty = buildSnapshot({ series: {}, today: TODAY })
  assert.equal(empty.l1.bias_raw, 0)
  assert.ok(empty.data_health.missing.length > 0, 'an empty fetch is loudly unhealthy')
})

test('a stale calendar cannot type the day', () => {
  // The failure this guards: a weekly file nobody refreshed still parses, holds
  // no events dated today, and would otherwise yield a confident
  // "normal day, cap 100%" from a file that never heard of today.
  const snapshot = buildSnapshot({
    series: quietSeries(),
    calendar: [
      { title: 'CPI m/m', country: 'USD', impact: 'High', date: '2026-08-27T08:30:00-04:00' },
    ],
    today: TODAY,
  })

  assert.equal(snapshot.l2.day_type, null)
  assert.equal(snapshot.l2.calendar_stale, true)
  assert.equal(snapshot.l2.feed_ends, '2026-08-27')
  assert.ok(snapshot.data_health.stale.includes('CALENDAR'))
  assert.equal(snapshot.data_health.missing.includes('CALENDAR'), false, 'stale, not missing')
})

test('a fresh calendar types the day and is not flagged', () => {
  const snapshot = buildSnapshot({
    series: quietSeries(),
    calendar: [
      { title: 'CPI m/m', country: 'USD', impact: 'High', date: `${TODAY}T08:30:00-04:00` },
    ],
    today: TODAY,
  })

  assert.equal(snapshot.l2.day_type, 'tier1_event')
  assert.equal(snapshot.l2.calendar_stale, false)
  assert.equal(snapshot.data_health.stale.includes('CALENDAR'), false)
})

test('fetch errors are stored so a snapshot explains itself later', () => {
  const snapshot = buildSnapshot({
    series: {},
    fetchErrors: { DGS2: 'DGS2: FRED 400 Bad Request. The value for api_key is not registered.' },
    today: TODAY,
  })

  assert.match(snapshot.data_health.fetch_errors.DGS2, /not registered/)
  assert.deepEqual(buildSnapshot({ series: {}, today: TODAY }).data_health.fetch_errors, {})
})
