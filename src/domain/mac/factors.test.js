import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CARRY_USDJPY,
  SERIES,
  asOf,
  f1Growth,
  f2Inflation,
  f3Rates,
  f4Liquidity,
  f5Credit,
  f6Dollar,
  f7Vol,
  netLiquiditySeries,
  volEffect,
} from './factors.js'

const TODAY = '2026-09-08'

/** `n` daily observations ending on TODAY, newest last. */
function daily(n, value, end = TODAY) {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => {
    const date = new Date(endMs - (n - 1 - i) * 86400000).toISOString().slice(0, 10)
    return { date, value: value(i, n, date) }
  })
}

/**
 * A value function whose change over the last `window` observations is exactly
 * `delta`, and which is flat before that.
 *
 * The transforms count observations, not days, so a fixture has to place the
 * move inside the same window the transform reads. A linear ramp across the
 * whole series does not — it puts most of the move outside the lookback and
 * quietly tests a smaller number than it claims to.
 */
const moveOver = (endValue, delta, window = 20) => (i, n) =>
  endValue - delta * Math.min(1, Math.max(0, (n - 1 - i) / window))

/** `n` weekly observations ending on TODAY. */
function weekly(n, value, end = TODAY) {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(endMs - (n - 1 - i) * 7 * 86400000).toISOString().slice(0, 10),
    value: value(i, n),
  }))
}

/** `n` monthly observations, the newest dated `end`'s month. */
function monthly(n, value, endYear = 2026, endMonth = 8) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(endYear, endMonth - 1 - (n - 1 - i), 1))
    return { date: d.toISOString().slice(0, 10), value: value(i, n) }
  })
}

/** A step series: `before` for all but the last `after.length` observations. */
const ramp = (from, to) => (i, n) => from + ((to - from) * i) / (n - 1)

/* ------------------------------------------------------------------ F1 ---- */

const growthSeries = ({ gdpnow = 2.4, claims = ramp(230000, 230000) } = {}) => ({
  [SERIES.GDPNOW.id]: daily(5, () => gdpnow),
  [SERIES.ICSA.id]: weekly(20, claims),
})

test('F1 reads two of three, and claims alone cannot carry it', () => {
  // GDPNow above trend, claims falling — two expanding votes, no PMI.
  const result = f1Growth({
    series: growthSeries({ gdpnow: 2.4, claims: ramp(260000, 220000) }),
    prior: null,
    today: TODAY,
  })

  assert.equal(result.state, 0, 'the claims vote needs three weekly prints first')
  assert.equal(result.memory.claimsStreak, 1)
})

test('F1 claims vote confirms over three weekly prints, not three recomputes', () => {
  const series = growthSeries({ gdpnow: 2.4, claims: ramp(260000, 220000) })
  let memory = null

  // Same data, recomputed five times in one day.
  for (let i = 0; i < 5; i += 1) {
    memory = f1Growth({ series, prior: memory, today: TODAY }).memory
  }
  assert.equal(memory.claimsStreak, 1, 'one observation, one count')

  // Two more weekly prints.
  for (let week = 1; week <= 2; week += 1) {
    const end = new Date(Date.parse(`${TODAY}T00:00:00Z`) + week * 7 * 86400000)
      .toISOString()
      .slice(0, 10)
    const next = {
      [SERIES.GDPNOW.id]: daily(5, () => 2.4, end),
      [SERIES.ICSA.id]: weekly(20, ramp(260000, 220000), end),
    }
    memory = f1Growth({ series: next, prior: memory, today: end }).memory
  }

  assert.equal(memory.claimsVote, 1)
  assert.equal(memory.state, 1, 'GDPNow above trend plus a settled claims vote is +1')
})

test('F1 reaches −2 only with a sub-45 PMI and rising claims', () => {
  const series = growthSeries({ gdpnow: 1.2, claims: ramp(210000, 260000) })
  const pmi = { value: 43.2, date: '2026-09-01', history: [{ date: '2026-09-01', value: 43.2 }] }

  const result = f1Growth({ series, prior: null, pmi, today: TODAY })
  assert.equal(result.state, -2)

  const mild = f1Growth({ series, prior: null, pmi: { ...pmi, value: 47 }, today: TODAY })
  assert.notEqual(mild.state, -2)
})

test('F1 reaches +2 only with a booming PMI and GDPNow above 3', () => {
  const series = growthSeries({ gdpnow: 3.4, claims: ramp(260000, 210000) })
  const pmi = { value: 56.5, date: '2026-09-01', history: [{ date: '2026-09-01', value: 56.5 }] }

  assert.equal(f1Growth({ series, prior: null, pmi, today: TODAY }).state, 2)
  assert.notEqual(
    f1Growth({ series: growthSeries({ gdpnow: 2.8 }), prior: null, pmi, today: TODAY }).state,
    2
  )
})

test('F1 abstains when PMI level and momentum disagree', () => {
  // Above 50 but rolling over: a genuinely ambiguous reading, so no vote.
  const history = [
    { date: '2026-06-01', value: 54 },
    { date: '2026-07-01', value: 53 },
    { date: '2026-08-01', value: 52 },
  ]
  const pmi = { value: 50.5, date: '2026-09-01', history: [...history, { date: '2026-09-01', value: 50.5 }] }

  const result = f1Growth({
    series: growthSeries({ gdpnow: 1.5, claims: ramp(230000, 230000) }),
    prior: null,
    pmi,
    today: TODAY,
  })

  assert.match(result.note, /PMI 50\.5/)
  assert.equal(result.state, 0, 'one contracting vote is not two')
})

test('F1 names a missing ISM without pretending it is neutral', () => {
  const result = f1Growth({ series: growthSeries(), prior: null, today: TODAY })
  assert.deepEqual(result.missing, ['ISM_PMI'])
  assert.match(result.note, /PMI not entered/)
})

test('F1 carries forward when claims go stale', () => {
  const stale = {
    [SERIES.GDPNOW.id]: daily(5, () => 2.4),
    [SERIES.ICSA.id]: weekly(20, ramp(230000, 230000), '2026-07-01'),
  }

  const result = f1Growth({ series: stale, prior: { state: -1 }, today: TODAY })
  assert.equal(result.state, -1)
  assert.equal(result.carried, true)
  assert.deepEqual(result.stale, [SERIES.ICSA.id])
})

/* ------------------------------------------------------------------ F2 ---- */

/**
 * A core-inflation index that lands on `yoyPct` year-over-year with the last
 * three months running at `recentPct` annualised.
 *
 * Built from both endpoints inward rather than compounded forward: the two
 * statistics F2 compares are defined by three points of the series (now, three
 * months back, twelve months back), so those three are pinned exactly and the
 * rest is interpolation.
 */
function inflation({ yoyPct, recentPct }) {
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

const inflationSeries = (opts) => ({
  [SERIES.CPILFESL.id]: inflation(opts),
  [SERIES.PCEPILFE.id]: inflation(opts),
})

test('F2 scores +1 decelerating below 3 and +2 below 2.5', () => {
  assert.equal(
    f2Inflation({ series: inflationSeries({ yoyPct: 2.8, recentPct: 2.0 }), prior: null, today: TODAY }).state,
    1
  )
  assert.equal(
    f2Inflation({ series: inflationSeries({ yoyPct: 2.3, recentPct: 1.8 }), prior: null, today: TODAY }).state,
    2
  )
})

test('F2 scores −1 on re-acceleration alone and −2 when it is also hot', () => {
  assert.equal(
    f2Inflation({ series: inflationSeries({ yoyPct: 2.6, recentPct: 3.2 }), prior: null, today: TODAY }).state,
    -1,
    're-accelerating from a benign level is still a headwind'
  )
  assert.equal(
    f2Inflation({ series: inflationSeries({ yoyPct: 3.8, recentPct: 4.4 }), prior: null, today: TODAY }).state,
    -2
  )
})

test('F2 scores −1 on level alone even while decelerating', () => {
  const result = f2Inflation({
    series: inflationSeries({ yoyPct: 3.9, recentPct: 3.4 }),
    prior: null,
    today: TODAY,
  })

  assert.equal(result.state, -1)
  assert.match(result.note, /decelerating/)
})

test('F2 is 0 when decelerating but still between 3 and 3.5', () => {
  const result = f2Inflation({
    series: inflationSeries({ yoyPct: 3.2, recentPct: 2.9 }),
    prior: null,
    today: TODAY,
  })
  assert.equal(result.state, 0)
})

test('F2 changes only on a release, not on a recompute', () => {
  const hot = inflationSeries({ yoyPct: 3.8, recentPct: 4.4 })
  const first = f2Inflation({ series: hot, prior: null, today: TODAY })
  assert.equal(first.state, -2)

  // A cool print swapped in without advancing the observation date is ignored.
  const cool = inflationSeries({ yoyPct: 2.2, recentPct: 1.5 })
  const relabelled = {
    [SERIES.CPILFESL.id]: cool[SERIES.CPILFESL.id].map((row, i) => ({
      ...row,
      date: hot[SERIES.CPILFESL.id][i].date,
    })),
    [SERIES.PCEPILFE.id]: cool[SERIES.PCEPILFE.id].map((row, i) => ({
      ...row,
      date: hot[SERIES.PCEPILFE.id][i].date,
    })),
  }

  const second = f2Inflation({ series: relabelled, prior: first.memory, today: TODAY })
  assert.equal(second.state, -2, 'no new print, no new state')

  // The same numbers, published a month later, do move it.
  const shifted = {
    [SERIES.CPILFESL.id]: monthly(13, (i) => cool[SERIES.CPILFESL.id][i].value, 2026, 9),
    [SERIES.PCEPILFE.id]: monthly(13, (i) => cool[SERIES.PCEPILFE.id][i].value, 2026, 9),
  }
  const third = f2Inflation({ series: shifted, prior: second.memory, today: '2026-10-08' })
  assert.equal(third.state, 2)
})

test('F2 survives on PCE alone when CPI is missing', () => {
  const result = f2Inflation({
    series: { [SERIES.PCEPILFE.id]: inflation({ yoyPct: 3.8, recentPct: 4.4 }) },
    prior: null,
    today: TODAY,
  })

  assert.equal(result.state, -2)
  assert.deepEqual(result.missing, [SERIES.CPILFESL.id])
})

/* ------------------------------------------------------------------ F3 ---- */

/**
 * DFEDTARU is a daily series on FRED, so the fixture is daily too — a monthly
 * one would be stale against its seven-day budget and the factor would carry
 * forward instead of computing, which is not what these tests are about.
 */
const rateSeries = ({ ff = 4.5, ff6mAgo = 4.5, dgs2Bps = 0, realBps = 0 } = {}) => ({
  // Steps up on 1 April, so a lookup six months back from September lands on
  // the old level and today's reads the new one.
  [SERIES.DFEDTARU.id]: daily(220, (i, n, date) => (date < '2026-04-01' ? ff6mAgo : ff)),
  [SERIES.DGS2.id]: daily(40, moveOver(3.9, dgs2Bps / 100)),
  [SERIES.DGS10.id]: daily(40, () => 4.2),
  [SERIES.DFII10.id]: daily(40, moveOver(1.8, realBps / 100)),
})

/** Confirms a candidate over the five sessions F3 requires. */
function settle(factor, series, sessions, prior = null) {
  let memory = prior
  for (let i = 0; i < sessions; i += 1) memory = factor({ series, prior: memory, today: TODAY }).memory
  return factor({ series, prior: memory, today: TODAY })
}

test('F3 tightens on the 2Y alone, after five sessions', () => {
  const series = rateSeries({ dgs2Bps: 30 })

  assert.equal(f3Rates({ series, prior: null, today: TODAY }).state, 0, 'day one waits')
  assert.equal(settle(f3Rates, series, 4).state, -1)
})

test('F3 escalates to −2 only when real yields rise with it', () => {
  assert.equal(settle(f3Rates, rateSeries({ dgs2Bps: 30, realBps: 25 }), 4).state, -2)
  assert.equal(settle(f3Rates, rateSeries({ dgs2Bps: 30, realBps: 5 }), 4).state, -1)
})

test('F3 mirrors on the easing side', () => {
  assert.equal(settle(f3Rates, rateSeries({ dgs2Bps: -30 }), 4).state, 1)
  assert.equal(settle(f3Rates, rateSeries({ dgs2Bps: -30, realBps: -25 }), 4).state, 2)
})

test('F3 publishes a funds-rate move immediately', () => {
  // 100bps of cuts over six months is a fact, not a signal awaiting confirmation.
  const result = f3Rates({ series: rateSeries({ ff: 3.5, ff6mAgo: 4.5 }), prior: null, today: TODAY })
  assert.equal(result.state, 1)
  assert.equal(result.memory.changed, true)
})

test('F3 still confirms a ±2 even when policy drove the ±1', () => {
  const series = rateSeries({ ff: 3.5, ff6mAgo: 4.5, realBps: -25 })
  assert.equal(f3Rates({ series, prior: null, today: TODAY }).state, 0, 'the −2/+2 leg waits its five')
  assert.equal(settle(f3Rates, series, 4).state, 2)
})

test('F3 carries forward when the TIPS series is stale', () => {
  const series = rateSeries({ dgs2Bps: 30 })
  series[SERIES.DFII10.id] = daily(40, () => 1.8, '2026-06-01')

  const result = f3Rates({ series, prior: { state: 1 }, today: TODAY })
  assert.equal(result.state, 1)
  assert.equal(result.carried, true)
})

/* ------------------------------------------------------------------ F4 ---- */

/** WALCL is in millions; TGA and RRP in billions. Values here are billions. */
const liquiditySeries = ({ walclBn = ramp(7000, 7000), tgaBn = ramp(700, 700), rrpBn = ramp(300, 300) } = {}) => ({
  [SERIES.WALCL.id]: weekly(12, (i, n) => walclBn(i, n) * 1000),
  [SERIES.WTREGEN.id]: weekly(12, tgaBn),
  [SERIES.RRPONTSYD.id]: weekly(12, rrpBn),
})

test('net liquidity reconciles WALCL millions against TGA and RRP billions', () => {
  const series = liquiditySeries()
  const netLiq = netLiquiditySeries(
    series[SERIES.WALCL.id],
    series[SERIES.WTREGEN.id],
    series[SERIES.RRPONTSYD.id]
  )

  assert.equal(netLiq[netLiq.length - 1].value, 7000 - 700 - 300)
})

test('asOf takes the latest value on or before a date', () => {
  const rows = [
    { date: '2026-09-01', value: 1 },
    { date: '2026-09-05', value: 2 },
  ]

  assert.equal(asOf(rows, '2026-09-04'), 1)
  assert.equal(asOf(rows, '2026-09-05'), 2)
  assert.equal(asOf(rows, '2026-08-01'), null)
})

test('F4 needs two weekly prints to agree before it moves', () => {
  // Balance sheet up $80bn over the last four weeks.
  const series = liquiditySeries({ walclBn: (i, n) => (i < n - 4 ? 7000 : 7080) })

  const first = f4Liquidity({ series, prior: null, today: TODAY })
  assert.equal(first.state, 0, 'one weekly print is not two')

  const later = {
    [SERIES.WALCL.id]: weekly(13, (i, n) => (i < n - 4 ? 7000 : 7080) * 1000, '2026-09-15'),
    [SERIES.WTREGEN.id]: weekly(13, () => 700, '2026-09-15'),
    [SERIES.RRPONTSYD.id]: weekly(13, () => 300, '2026-09-15'),
  }
  const second = f4Liquidity({ series: later, prior: first.memory, today: '2026-09-15' })
  assert.equal(second.state, 1)
})

test('F4 ignores a move inside the ±50bn band', () => {
  const series = liquiditySeries({ walclBn: (i, n) => (i < n - 4 ? 7000 : 7030) })
  const result = f4Liquidity({ series, prior: { state: 0, weekSeen: '2020-01-01' }, today: TODAY })
  assert.equal(result.state, 0)
})

test('F4 forces −2 on a TGA rebuild even while net liquidity reads positive', () => {
  // The balance sheet adds $400bn but Treasury takes $200bn of it into the TGA.
  const series = liquiditySeries({
    walclBn: (i, n) => (i < n - 4 ? 7000 : 7400),
    tgaBn: (i, n) => (i < n - 4 ? 700 : 900),
  })

  let memory = f4Liquidity({ series, prior: null, today: TODAY }).memory
  const later = {
    [SERIES.WALCL.id]: weekly(13, (i, n) => (i < n - 4 ? 7000 : 7400) * 1000, '2026-09-15'),
    [SERIES.WTREGEN.id]: weekly(13, (i, n) => (i < n - 4 ? 700 : 900), '2026-09-15'),
    [SERIES.RRPONTSYD.id]: weekly(13, () => 300, '2026-09-15'),
  }
  const result = f4Liquidity({ series: later, prior: memory, today: '2026-09-15' })

  assert.equal(result.state, -2)
  assert.ok(result.inputs.net_liq_4w_bn > 0, 'net liquidity itself was positive')
})

test('F4 names the largest driver', () => {
  const series = liquiditySeries({ rrpBn: (i, n) => (i < n - 4 ? 500 : 380) })
  const result = f4Liquidity({ series, prior: null, today: TODAY })
  assert.match(result.note, /driver: RRP/)
})

/* ------------------------------------------------------------------ F5 ---- */

/** FRED publishes OAS in percent, so 3.05 means 305bps. */
const creditSeries = (bps) => ({
  [SERIES.BAMLH0A0HYM2.id]: daily(30, (i, n) => bps(i, n) / 100),
  [SERIES.BAMLC0A0CM.id]: daily(30, () => 1.05),
})

/** Confirms a level bucket over the three closes F5 requires. */
const settleCredit = (series, prior = null) => settle(f5Credit, series, 3, prior)

test('F5 never scores positive at tight spreads', () => {
  const result = settleCredit(creditSeries(() => 260))
  assert.equal(result.state, 0)
  assert.equal(result.inputs.hy_oas, 260)
})

test('F5 level buckets step at 300, 400 and 600', () => {
  assert.equal(settleCredit(creditSeries(() => 350)).state, -1)
  assert.equal(settleCredit(creditSeries(() => 450)).state, -2)
  assert.equal(settleCredit(creditSeries(() => 700)).state, -3)
  assert.equal(settleCredit(creditSeries(() => 300)).state, -1, '300 is inside the first bucket')
})

test('F5 level buckets need three closes', () => {
  const series = creditSeries(() => 450)
  assert.equal(f5Credit({ series, prior: null, today: TODAY }).state, 0)
  assert.equal(settle(f5Credit, series, 2).state, -2)
})

test('F5 speed override applies immediately and stacks on the bucket', () => {
  // 280bps to 340bps over the last ten sessions: +60bps of widening.
  const series = creditSeries((i, n) => (i < n - 10 ? 280 : 280 + ((i - (n - 11)) * 60) / 10))

  const first = f5Credit({ series, prior: null, today: TODAY })
  assert.equal(first.inputs.speed_override, true)
  assert.equal(first.state, -1, 'the override lands on day one, before any bucket has confirmed')

  const settled = settleCredit(series)
  assert.equal(settled.inputs.level_bucket, -1)
  assert.equal(settled.state, -2, 'bucket −1 plus the override')
})

test('F5 removes the override only after a real retrace', () => {
  const widened = { state: -1, speed: true, streak: 0, candidate: null }

  // Drifting sideways keeps it on.
  const flat = f5Credit({ series: creditSeries(() => 380), prior: widened, today: TODAY })
  assert.equal(flat.inputs.speed_override, true)

  // 45bps of tightening over ten sessions takes it off.
  const relief = creditSeries((i, n) => (i < n - 10 ? 380 : 380 - ((i - (n - 11)) * 45) / 10))
  const cleared = f5Credit({ series: relief, prior: widened, today: TODAY })
  assert.equal(cleared.inputs.speed_override, false)
})

test('F5 reads FRED percent as basis points, not the other way round', () => {
  const result = settleCredit(creditSeries(() => 512))
  assert.equal(result.inputs.hy_oas, 512)
  assert.equal(result.inputs.hy_10d_bps, 0)
})

/* ------------------------------------------------------------------ F6 ---- */

const dollarSeries = ({ pct = 0, usdjpy = 148 } = {}) => ({
  [SERIES.DTWEXBGS.id]: daily(30, moveOver(100 * (1 + pct / 100), pct)),
  [SERIES.DEXJPUS.id]: daily(30, () => usdjpy),
})

test('F6 needs five sessions past ±1.5%', () => {
  const series = dollarSeries({ pct: 2.2 })
  assert.equal(f6Dollar({ series, prior: null, today: TODAY }).state, 0)
  assert.equal(settle(f6Dollar, series, 4).state, -1)
})

test('F6 mirrors on a weakening dollar', () => {
  assert.equal(settle(f6Dollar, dollarSeries({ pct: -2.2 }), 4).state, 1)
})

test('F6 ignores a move inside the band', () => {
  assert.equal(settle(f6Dollar, dollarSeries({ pct: 0.9 }), 6).state, 0)
})

test('F6 carry risk is a flag and never touches the state', () => {
  const hot = settle(f6Dollar, dollarSeries({ pct: 0, usdjpy: CARRY_USDJPY + 3 }), 6)

  assert.equal(hot.state, 0, 'carry accumulation is a tail risk, not today’s headwind')
  assert.equal(hot.inputs.carry_risk, true)
  assert.match(hot.note, /carry accumulation elevated/)

  const calm = settle(f6Dollar, dollarSeries({ pct: 0, usdjpy: CARRY_USDJPY - 3 }), 6)
  assert.equal(calm.inputs.carry_risk, false)
  assert.doesNotMatch(calm.note, /carry accumulation/)
})

/* ------------------------------------------------------------------ F7 ---- */

const volSeries = ({ vix = 15, vix3m = 17, ndx = () => 20000 } = {}) => ({
  [SERIES.VIXCLS.id]: daily(30, () => vix),
  [SERIES.VXVCLS.id]: daily(30, () => vix3m),
  [SERIES.NASDAQ100.id]: daily(300, ndx),
})

test('F7 classifies calm, elevated and hostile', () => {
  assert.equal(f7Vol({ series: volSeries({ vix: 15, vix3m: 17 }), prior: null, today: TODAY }).regime, 'calm')
  assert.equal(f7Vol({ series: volSeries({ vix: 24, vix3m: 26 }), prior: null, today: TODAY }).regime, 'elevated')
  assert.equal(f7Vol({ series: volSeries({ vix: 34, vix3m: 30 }), prior: null, today: TODAY }).regime, 'hostile')
})

test('F7 treats backwardation as hostile at any level', () => {
  // VIX 19 is calm by level, but above VIX3M the curve is inverted.
  const result = f7Vol({ series: volSeries({ vix: 19, vix3m: 18 }), prior: null, today: TODAY })
  assert.equal(result.regime, 'hostile')
  assert.match(result.note, /backwardated/)
})

test('F7 enters hostile immediately and leaves over three sessions', () => {
  const spike = volSeries({ vix: 36, vix3m: 30 })
  const calm = volSeries({ vix: 14, vix3m: 17 })

  let memory = f7Vol({ series: spike, prior: null, today: TODAY }).memory
  assert.equal(memory.state, 2)

  let regime
  for (let i = 0; i < 2; i += 1) {
    const step = f7Vol({ series: calm, prior: memory, today: TODAY })
    memory = step.memory
    regime = step.regime
  }
  assert.equal(regime, 'hostile', 'two calm sessions do not undo a spike')

  assert.equal(f7Vol({ series: calm, prior: memory, today: TODAY }).regime, 'calm')
})

test('F7 computes realised vol and its z-score from NDX closes', () => {
  // A year of quiet, then ten violent sessions.
  const ndx = (i, n) => (i < n - 10 ? 20000 + (i % 2) * 5 : 20000 + (i % 2) * 900)
  const result = f7Vol({ series: volSeries({ vix: 18, vix3m: 20, ndx }), prior: null, today: TODAY })

  assert.ok(result.inputs.rv20 > 0)
  assert.ok(result.inputs.rv20_z > 2, 'a vol explosion should score past two sigma')
  assert.equal(result.regime, 'hostile', 'realised vol alone can force hostile')
})

test('F7 treats an unavailable z-score as no objection, not as stress', () => {
  const series = volSeries({ vix: 15, vix3m: 17 })
  series[SERIES.NASDAQ100.id] = []

  const result = f7Vol({ series, prior: null, today: TODAY })
  assert.equal(result.inputs.rv20_z, null)
  assert.equal(result.regime, 'calm')
})

test('F7 carries the regime forward when VIX is missing', () => {
  const result = f7Vol({ series: {}, prior: { state: 2 }, today: TODAY })
  assert.equal(result.regime, 'hostile')
  assert.equal(result.carried, true)
})

test('volEffect is the whole cost of a vol regime, in one place', () => {
  assert.deepEqual(volEffect('calm'), { size_cap: 1, spm_allowed: true, mm_preferred: false })
  assert.deepEqual(volEffect('elevated'), { size_cap: 0.75, spm_allowed: true, mm_preferred: true })
  assert.deepEqual(volEffect('hostile'), { size_cap: 0.5, spm_allowed: false, mm_preferred: true })
})
