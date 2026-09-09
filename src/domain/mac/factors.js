/**
 * The seven macro factors.
 *
 * Each factor is a pure function of parsed FRED series plus yesterday's memory.
 * It returns a state, the inputs that produced it, a mechanism sentence, a flip
 * condition, and the memory the next day needs. No factor knows about the
 * regime, the bar, or the UI.
 *
 * Two conventions hold throughout:
 *
 *   1. Negative is an NQ headwind. Every state, everywhere, without exception.
 *   2. A state is never invented from missing data. If an input is absent or
 *      stale past its publication cadence, the factor carries yesterday's state
 *      forward and reports why — the fail-loud pattern from the GEX snapshot.
 *      Silence would look identical to a genuine neutral reading.
 *
 * @typedef {object} FactorResult
 * @property {number} state
 * @property {object} inputs the numbers behind the state, for the snapshot
 * @property {string} note the mechanism, with direction filled in
 * @property {{when: string|null, what: string}} flip what would change it
 * @property {object} memory carried into tomorrow's computation
 * @property {boolean} carried true when the state is yesterday's, not today's
 * @property {string[]} missing input ids that were unavailable
 * @property {string[]} stale input ids whose latest observation is too old
 */

import {
  annualised3m,
  changeOverBps,
  daysBetween,
  isStale,
  last,
  lastDate,
  lastValue,
  meanOfLast,
  monthsBackPair,
  pctChangeOver,
  realisedVol,
  realisedVolSeries,
  yoy,
  zScore,
} from './fred.js'
import { carryForward, confirm, confirmOnRelease, memory } from './hysteresis.js'

/**
 * Every series mac reads, with how old its latest observation may be before the
 * factor stops trusting it. The budgets are cadence plus slack for holidays and
 * for FRED's own publication lag — daily series post the next afternoon, the
 * H.4.1 lands Thursday, monthly prints land mid-month.
 *
 * **The budget is measured against the observation date, not the release date**,
 * and for anything slower than daily those are far apart. A monthly print is
 * dated the first of the month it *describes* and published four to eight weeks
 * later, so its age on the day it lands is already most of the old budget. The
 * first three of these were set as if the two dates were the same, and every one
 * of them was unsatisfiable — GDPNow could not be fresh on any day in history,
 * because the youngest observation it ever offers is 25 days old against what
 * used to be a 21-day budget.
 *
 * The values below are measured, not guessed: they come from the observed age
 * distribution over 2,583 replayed sessions (2016-2026), set near the 90th
 * percentile so ordinary operation is never flagged and a genuine outage still
 * is.
 *
 *   series      p50   p90   p99   max      budget
 *   GDPNOW       77   115   163   207   →     120
 *   CPILFESL     56    69    77   107   →      80
 *   PCEPILFE     74    87   116   142   →     120
 *   ICSA          9    11    25    60   →      14  (unchanged; correct already)
 */
export const SERIES = Object.freeze({
  GDPNOW: { id: 'GDPNOW', label: 'GDPNow', budgetDays: 120 },
  ICSA: { id: 'ICSA', label: 'initial claims', budgetDays: 14 },
  CPILFESL: { id: 'CPILFESL', label: 'core CPI', budgetDays: 80 },
  PCEPILFE: { id: 'PCEPILFE', label: 'core PCE', budgetDays: 120 },
  DFEDTARU: { id: 'DFEDTARU', label: 'fed funds upper', budgetDays: 7 },
  DGS2: { id: 'DGS2', label: '2Y', budgetDays: 7 },
  DGS10: { id: 'DGS10', label: '10Y', budgetDays: 7 },
  DFII10: { id: 'DFII10', label: '10Y TIPS', budgetDays: 7 },
  WALCL: { id: 'WALCL', label: 'Fed assets', budgetDays: 14 },
  WTREGEN: { id: 'WTREGEN', label: 'TGA', budgetDays: 14 },
  RRPONTSYD: { id: 'RRPONTSYD', label: 'ON RRP', budgetDays: 14 },
  BAMLH0A0HYM2: { id: 'BAMLH0A0HYM2', label: 'HY OAS', budgetDays: 7 },
  BAMLC0A0CM: { id: 'BAMLC0A0CM', label: 'IG OAS', budgetDays: 7 },
  DTWEXBGS: { id: 'DTWEXBGS', label: 'broad dollar', budgetDays: 10 },
  DEXJPUS: { id: 'DEXJPUS', label: 'USD/JPY', budgetDays: 10 },
  VIXCLS: { id: 'VIXCLS', label: 'VIX', budgetDays: 7 },
  VXVCLS: { id: 'VXVCLS', label: 'VIX3M', budgetDays: 7 },
  NASDAQ100: { id: 'NASDAQ100', label: 'NDX close', budgetDays: 7 },
})

/** Typical days between observations, used to date the next expected print. */
const CADENCE = { daily: 1, weekly: 7, monthly: 30, quarterly: 91 }

const num = (value, digits = 1) =>
  value == null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits)

/** Signed to one decimal, so a note reads "+27bps" rather than "27bps". */
const signed = (value, digits = 1) =>
  value == null || !Number.isFinite(value)
    ? 'n/a'
    : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`

const rounded = (value, digits = 1) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits))

/** The date a series is next expected to print, from its own last observation. */
function nextExpected(series, days) {
  const date = lastDate(series)
  if (!date) return null
  const at = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(at)) return null
  return new Date(at + days * 86400000).toISOString().slice(0, 10)
}

/**
 * Which of `ids` are missing or stale. A factor asks this before computing so
 * that "no data" and "neutral" never look the same downstream.
 */
function health(series, ids, today) {
  const missing = []
  const stale = []

  for (const id of ids) {
    const rows = series[id]
    if (!rows || rows.length === 0) missing.push(id)
    else if (isStale(rows, today, SERIES[id].budgetDays)) stale.push(id)
  }

  return { missing, stale, ok: missing.length === 0 && stale.length === 0 }
}

/** A factor held at yesterday's state because its inputs could not be trusted. */
function held(prior, { missing, stale }, inputs = {}) {
  const before = carryForward(prior)
  const why = [...missing, ...stale].map((id) => SERIES[id]?.label ?? id).join(', ')

  return {
    state: before.state,
    inputs,
    note: `Carried forward — ${why} unavailable or stale. State is yesterday's, not today's.`,
    flip: { when: null, what: 'Resumes updating once the input publishes.' },
    memory: before,
    carried: true,
    missing,
    stale,
  }
}

/* ------------------------------------------------------------------ F1 ---- */

/**
 * Growth: GDPNow against its 2.0% trend, ISM PMI against 50 and its own
 * 3-month average, and initial claims 4-week MA against the 13-week average.
 *
 * ISM is not on FRED and is not free anywhere reliable, so `pmi` is harvested
 * from ForexFactory and carried inside the snapshot from then on. Two of the
 * three inputs decide the state; the extremes need PMI, so with no PMI the
 * factor can still read ±1 but never ±2.
 *
 * **Claims are the backbone; the other two may drop out.** This factor used to
 * hold at yesterday's state whenever *any* input was stale, and because GDPNow's
 * observation is dated the quarter it forecasts rather than the day it is
 * published, that condition was true on every single day — the factor sat at 0
 * from the day it shipped and never voted on anything. The fix is the rule F2
 * already used and documented: hold only when the input the factor cannot work
 * without has gone, and let the others degrade to a missing vote.
 *
 * So a stale GDPNow costs its vote, not the factor, and it is reported as stale
 * rather than swallowed.
 *
 * The claims vote is the only daily-updating input, and it is the one that
 * would make this factor wobble, so it carries its own three-week confirmation
 * counted in weekly observations rather than in recomputes.
 *
 * @param {object} input
 * @param {Record<string, Array<{date: string, value: number}>>} input.series
 * @param {object} input.prior yesterday's memory for this factor
 * @param {{value: number|null, date: string|null, history: Array<{date: string, value: number}>}} [input.pmi]
 * @param {string} input.today
 * @returns {FactorResult}
 */
export function f1Growth({ series, prior, pmi = { value: null, date: null, history: [] }, today }) {
  const ids = [SERIES.GDPNOW.id, SERIES.ICSA.id]
  const feed = health(series, ids, today)

  const claims = series[SERIES.ICSA.id] ?? []
  const claims4w = meanOfLast(claims, 4)
  const claims13w = meanOfLast(claims, 13)
  const gdpnow = lastValue(series[SERIES.GDPNOW.id] ?? [])

  // Claims carry the factor. Without a usable 4-week and 13-week average there
  // is no daily-updating input left and nothing to compute, so the state holds.
  const claimsGone =
    feed.missing.includes(SERIES.ICSA.id) || feed.stale.includes(SERIES.ICSA.id)

  if (claimsGone || claims4w == null || claims13w == null) {
    return held(prior, feed, { gdpnow, claims_4w: rounded(claims4w, 0), pmi: pmi.value })
  }

  // GDPNow votes only while it is current. Between quarters it can go months
  // without a new observation, and a nowcast that old is not a nowcast — but it
  // is also no reason to stop reading claims and ISM.
  const gdpUsable =
    gdpnow != null &&
    !feed.missing.includes(SERIES.GDPNOW.id) &&
    !feed.stale.includes(SERIES.GDPNOW.id)

  const before = memory(prior)

  // The claims vote, confirmed over three weekly prints. `claimsSeen` is the
  // observation date the streak was last advanced on, so a recompute at 11:00
  // and again at 15:00 on the same Thursday counts once, not twice.
  const claimsRising = claims4w > claims13w
  const claimsVote = claimsRising ? -1 : 1
  const claimsDate = lastDate(claims)
  const newClaims = before.claimsSeen == null || claimsDate > before.claimsSeen
  const claimsMemory = newClaims
    ? confirm({
        candidate: claimsVote,
        prior: { state: before.claimsVote ?? 0, candidate: before.claimsCandidate ?? null, streak: before.claimsStreak ?? 0 },
        confirmations: CLAIMS_CONFIRMATIONS,
      })
    : {
        state: before.claimsVote ?? 0,
        candidate: before.claimsCandidate ?? null,
        streak: before.claimsStreak ?? 0,
      }

  // GDPNow votes on level against the 2.0% trend the spec anchors to.
  const gdpVote = !gdpUsable ? 0 : gdpnow > GDP_TREND ? 1 : gdpnow < GDP_TREND ? -1 : 0

  // PMI votes only when level and momentum agree. Above 50 while rolling over
  // is a genuinely ambiguous reading, and forcing it into a vote is how a
  // growth factor ends up long into a turn.
  const pmiAvg3 = meanOfLast(pmi.history ?? [], 3)
  const pmiDelta = pmi.value != null && pmiAvg3 != null ? pmi.value - pmiAvg3 : null
  let pmiVote = 0
  if (pmi.value != null) {
    if (pmi.value > PMI_NEUTRAL && (pmiDelta == null || pmiDelta >= 0)) pmiVote = 1
    else if (pmi.value < PMI_NEUTRAL && (pmiDelta == null || pmiDelta <= 0)) pmiVote = -1
  }

  const votes = [gdpVote, pmiVote, claimsMemory.state]
  const expanding = votes.filter((v) => v > 0).length
  const contracting = votes.filter((v) => v < 0).length

  let candidate = 0
  if (pmi.value != null && pmi.value < PMI_RECESSION && claimsRising) candidate = -2
  else if (pmi.value != null && pmi.value > PMI_BOOM && gdpUsable && gdpnow > GDP_STRONG) candidate = 2
  else if (expanding >= 2) candidate = 1
  else if (contracting >= 2) candidate = -1

  // Every other input here moves only on its own release, and the claims vote
  // has already served its three weeks, so the composite publishes at once.
  const settled = confirm({ candidate, prior: before, confirmations: 1 })

  const direction = candidate > 0 ? 'accelerating' : candidate < 0 ? 'decelerating' : 'flat'
  const earnings = candidate > 0 ? 'expand' : candidate < 0 ? 'compress' : 'hold'

  return {
    state: settled.state,
    inputs: {
      gdpnow,
      pmi: pmi.value,
      pmi_avg_3m: rounded(pmiAvg3, 1),
      claims_4w: rounded(claims4w, 0),
      claims_13w: rounded(claims13w, 0),
    },
    note:
      `Growth ${direction}: GDPNow ${num(gdpnow)}%${gdpUsable ? '' : ' (stale, not voting)'} ` +
      `vs ${GDP_TREND.toFixed(1)}% trend, ` +
      `${pmi.value == null ? 'PMI not entered' : `PMI ${num(pmi.value)}`}, ` +
      `claims 4wMA ${num(claims4w, 0)} vs 13w ${num(claims13w, 0)} ` +
      `(${claimsRising ? 'rising' : 'falling'}) → earnings expectations ${earnings}.`,
    flip: {
      when: nextExpected(claims, CADENCE.weekly),
      what:
        pmi.value == null
          ? 'Enter ISM on release day; claims crossing the 13-week average for three weeks flips the claims vote.'
          : `ISM below ${PMI_RECESSION} with claims rising → −2; claims crossing the 13-week average for three weeks flips the claims vote.`,
    },
    memory: {
      ...settled,
      claimsVote: claimsMemory.state,
      claimsCandidate: claimsMemory.candidate,
      claimsStreak: claimsMemory.streak,
      claimsSeen: newClaims ? claimsDate : before.claimsSeen ?? claimsDate,
    },
    carried: false,
    // Propagated rather than dropped: a factor that computed on a degraded feed
    // must say so, or `data_health` reports a clean read of partial inputs.
    missing: [...feed.missing, ...(pmi.value == null ? ['ISM_PMI'] : [])],
    stale: feed.stale,
  }
}

export const GDP_TREND = 2.0
export const GDP_STRONG = 3.0
export const PMI_NEUTRAL = 50
export const PMI_RECESSION = 45
export const PMI_BOOM = 55
export const CLAIMS_CONFIRMATIONS = 3

/* ------------------------------------------------------------------ F2 ---- */

export const CPI_LOW = 2.5
export const CPI_TARGET_BAND = 3.0
export const CPI_HIGH = 3.5

/**
 * Inflation: direction from 3-month annualised against year-over-year, level
 * from core YoY.
 *
 * The 3m-vs-YoY comparison is the whole point. YoY still carries nine months of
 * prints that already happened, so at a turn it lags by a quarter; the 3-month
 * annualised rate is where a re-acceleration shows up first. Both core CPI and
 * core PCE vote on direction — one print can be a tax quirk, two agreeing is a
 * trend — while the level is quoted from CPI, which is what actually reprices
 * the front end on the day.
 *
 * @returns {FactorResult}
 */
export function f2Inflation({ series, prior, today }) {
  const ids = [SERIES.CPILFESL.id, SERIES.PCEPILFE.id]
  const feed = health(series, ids, today)

  const cpi = series[SERIES.CPILFESL.id] ?? []
  const pce = series[SERIES.PCEPILFE.id] ?? []

  const cpiYoy = yoy(cpi)
  const cpi3m = annualised3m(cpi)
  const pceYoy = yoy(pce)
  const pce3m = annualised3m(pce)

  // PCE alone is enough to keep the factor alive: it is the Fed's own gauge and
  // it prints later, so a stale CPI is survivable while the direction still has
  // a second opinion behind it.
  const level = cpiYoy ?? pceYoy
  const gaps = [
    cpi3m != null && cpiYoy != null ? cpi3m - cpiYoy : null,
    pce3m != null && pceYoy != null ? pce3m - pceYoy : null,
  ].filter((gap) => gap != null)

  if (feed.missing.length === ids.length || level == null || gaps.length === 0) {
    return held(prior, feed, { core_cpi_yoy: rounded(cpiYoy, 2), core_cpi_3m: rounded(cpi3m, 2) })
  }

  const gap = gaps.reduce((sum, g) => sum + g, 0) / gaps.length
  const reaccelerating = gap > 0
  const decelerating = gap < 0

  let candidate = 0
  if (reaccelerating && level > CPI_HIGH) candidate = -2
  else if (reaccelerating || level > CPI_HIGH) candidate = -1
  else if (decelerating && level < CPI_LOW) candidate = 2
  else if (decelerating && level < CPI_TARGET_BAND) candidate = 1

  // Core CPI does not become more true by being looked at on a Tuesday. The
  // gate is the newest observation date across both series.
  const releaseDate = [lastDate(cpi), lastDate(pce)].filter(Boolean).sort().pop() ?? null
  const settled = confirmOnRelease({ candidate, prior, releaseDate })

  const direction = reaccelerating ? 're-accelerating' : decelerating ? 'decelerating' : 'flat'
  const fed = candidate < 0 ? 'constrained' : candidate > 0 ? 'has room' : 'on hold'
  const discount = candidate < 0 ? 'up' : candidate > 0 ? 'down' : 'unchanged'

  return {
    state: settled.state,
    inputs: {
      core_cpi_yoy: rounded(cpiYoy, 2),
      core_cpi_3m: rounded(cpi3m, 2),
      core_pce_yoy: rounded(pceYoy, 2),
      core_pce_3m: rounded(pce3m, 2),
    },
    note:
      `Core inflation ${direction} at ${num(level, 1)}% YoY ` +
      `(3m annualised ${num(cpi3m ?? pce3m, 1)}%) → Fed ${fed} → discount rate ${discount}.`,
    flip: {
      when: nextExpected(cpi, CADENCE.monthly),
      what:
        candidate < 0
          ? `Core 3m annualised back below YoY and level under ${CPI_TARGET_BAND.toFixed(1)}% → 0 or better.`
          : `Core 3m annualised above YoY, or level above ${CPI_HIGH.toFixed(1)}% → headwind.`,
    },
    memory: settled,
    carried: false,
    missing: feed.missing,
    stale: feed.stale,
  }
}

/* ------------------------------------------------------------------ F3 ---- */

export const FF_MOVE = 0.5
export const DGS2_MOVE_BPS = 25
export const REAL_MOVE_BPS = 20
export const RATES_CONFIRMATIONS = 5

/**
 * Rate trajectory: where policy has been over six months, where the 2Y has been
 * over twenty sessions, and what the real yield did alongside it.
 *
 * The real-yield leg is what separates a −1 from a −2. Nominal yields rising on
 * better growth is survivable for NQ; the 10Y TIPS yield rising is the discount
 * rate on long-duration cash flows going up with no growth offset, which is the
 * single worst combination for the index. That is why the −2 requires both.
 *
 * A move driven by the funds rate itself publishes immediately — the Fed
 * changing target is a fact, not a signal needing five days of confirmation.
 * A move driven by the 2Y or by real yields serves the full five sessions.
 *
 * @returns {FactorResult}
 */
export function f3Rates({ series, prior, today }) {
  const ids = [SERIES.DFEDTARU.id, SERIES.DGS2.id, SERIES.DFII10.id]
  const feed = health(series, ids, today)

  const ff = series[SERIES.DFEDTARU.id] ?? []
  const dgs2 = series[SERIES.DGS2.id] ?? []
  const dgs10 = series[SERIES.DGS10.id] ?? []
  const tips = series[SERIES.DFII10.id] ?? []

  const ffPair = monthsBackPair(ff, 6)
  const ff6m = ffPair ? ffPair.now - ffPair.then : null
  const dgs2_20d = changeOverBps(dgs2, 20)
  const real_20d = changeOverBps(tips, 20)

  if (!feed.ok || (ff6m == null && dgs2_20d == null)) {
    return held(prior, feed, {
      ff_6m: rounded(ff6m, 2),
      dgs2_20d_bps: rounded(dgs2_20d, 0),
      real_20d_bps: rounded(real_20d, 0),
    })
  }

  const ffEasing = ff6m != null && ff6m <= -FF_MOVE
  const ffTightening = ff6m != null && ff6m >= FF_MOVE
  const easing = ffEasing || (dgs2_20d != null && dgs2_20d <= -DGS2_MOVE_BPS)
  const tightening = ffTightening || (dgs2_20d != null && dgs2_20d >= DGS2_MOVE_BPS)

  let candidate = 0
  if (tightening) candidate = real_20d != null && real_20d >= REAL_MOVE_BPS ? -2 : -1
  else if (easing) candidate = real_20d != null && real_20d <= -REAL_MOVE_BPS ? 2 : 1

  // Policy-driven moves skip the queue; market-driven ones do not.
  const policyDriven = ffEasing || ffTightening
  const settled = confirm({
    candidate,
    prior,
    confirmations: RATES_CONFIRMATIONS,
    immediate: () => policyDriven && Math.abs(candidate) === 1,
  })

  const twos = dgs2_20d != null && dgs2_20d >= 0 ? 'up' : 'down'
  const reals = real_20d != null && real_20d >= 0 ? 'up' : 'down'
  const pricing = tightening ? 'more' : easing ? 'less' : 'unchanged'
  const multiple = candidate < 0 ? 'compression' : candidate > 0 ? 'expansion' : 'unchanged'

  return {
    state: settled.state,
    inputs: {
      ff_6m: rounded(ff6m, 2),
      dgs2: lastValue(dgs2),
      dgs2_20d_bps: rounded(dgs2_20d, 0),
      dgs10: lastValue(dgs10),
      real_20d_bps: rounded(real_20d, 0),
      dfii10: lastValue(tips),
    },
    note:
      `2Y ${twos} ${num(Math.abs(dgs2_20d ?? NaN), 0)}bps over 20d, real yields ${reals} ` +
      `${num(Math.abs(real_20d ?? NaN), 0)}bps: market pricing ${pricing} tightening → NQ multiple ${multiple}.`,
    flip: {
      when: nextExpected(dgs2, CADENCE.daily),
      what: `2Y crossing ${signed(-DGS2_MOVE_BPS, 0)}/${signed(DGS2_MOVE_BPS, 0)}bps over 20d for five sessions; real yields past ${signed(REAL_MOVE_BPS, 0)}bps escalates to ±2.`,
    },
    memory: settled,
    carried: false,
    missing: feed.missing,
    stale: feed.stale,
  }
}

/* ------------------------------------------------------------------ F4 ---- */

export const NET_LIQ_MOVE_BN = 50
export const TGA_REBUILD_BN = 150

/**
 * FRED publishes WALCL and WTREGEN in millions and RRPONTSYD in billions, and
 * everything here is billions.
 *
 * This was wrong in the first version and wrong in a way that hid: WALCL was
 * scaled and WTREGEN was not, so "net liquidity" came out around −961,000bn
 * instead of +5,769bn. Because the error term is a thousand times the TGA, the
 * factor was not reading net liquidity at all — it was reading the inverse of
 * the Treasury's cash balance, amplified, with the balance sheet and the RRP
 * rounded into irrelevance. The sign happened to be right, which is why nothing
 * looked broken.
 *
 * Any new series added here needs its units checked against FRED's `units_short`
 * rather than assumed from its neighbours.
 */
export const MILLIONS_TO_BN = 1 / 1000
export const LIQUIDITY_CONFIRMATIONS = 2

/**
 * Net liquidity: Fed assets less the Treasury General Account less overnight
 * reverse repo, in billions, changed over four weeks.
 *
 * The series is built on the H.4.1's own weekly dates, taking TGA and RRP as of
 * each of those dates rather than pairing whatever happened to print last.
 * Mixing a Wednesday balance sheet with a Friday TGA manufactures a delta that
 * never existed.
 *
 * The TGA override exists because the post-debt-ceiling rebuild is the one
 * pattern where every component can look benign while the drain is severe:
 * Treasury refilling its account pulls cash out of the system regardless of
 * what the balance sheet is doing.
 *
 * @returns {FactorResult}
 */
export function f4Liquidity({ series, prior, today }) {
  const ids = [SERIES.WALCL.id, SERIES.WTREGEN.id, SERIES.RRPONTSYD.id]
  const feed = health(series, ids, today)

  const walcl = series[SERIES.WALCL.id] ?? []
  const tga = series[SERIES.WTREGEN.id] ?? []
  const rrp = series[SERIES.RRPONTSYD.id] ?? []

  const netLiq = netLiquiditySeries(walcl, tga, rrp)

  if (!feed.ok || netLiq.length < 5) {
    return held(prior, feed, { net_liq_bn: rounded(lastValue(netLiq), 0) })
  }

  const nl4w = netLiq[netLiq.length - 1].value - netLiq[netLiq.length - 5].value
  const tga4w = alignedChange(tga, netLiq, 4, MILLIONS_TO_BN)
  const rrp4w = alignedChange(rrp, netLiq, 4)
  const walcl4w = alignedChange(walcl, netLiq, 4, MILLIONS_TO_BN)

  const before = memory(prior)

  let candidate = 0
  if (nl4w > NET_LIQ_MOVE_BN) candidate = 1
  else if (nl4w < -NET_LIQ_MOVE_BN) candidate = -1
  if (tga4w != null && tga4w > TGA_REBUILD_BN) candidate = -2

  // Weekly series, weekly confirmation: the streak advances on a new H.4.1, not
  // on a recompute.
  const weekDate = netLiq[netLiq.length - 1].date
  const newWeek = before.weekSeen == null || weekDate > before.weekSeen
  const settled = newWeek
    ? confirm({ candidate, prior: before, confirmations: LIQUIDITY_CONFIRMATIONS })
    : { ...before, changed: false, pending: false }

  const driver = largestDriver({ TGA: -(tga4w ?? 0), RRP: -(rrp4w ?? 0), 'balance sheet': walcl4w ?? 0 })
  const trend = nl4w >= 0 ? 'rising' : 'falling'
  const wind = settled.state > 0 ? 'tailwind' : settled.state < 0 ? 'headwind' : 'neutral'

  return {
    state: settled.state,
    inputs: {
      net_liq_bn: rounded(netLiq[netLiq.length - 1].value, 0),
      net_liq_4w_bn: rounded(nl4w, 0),
      tga_4w_bn: rounded(tga4w, 0),
      rrp_4w_bn: rounded(rrp4w, 0),
      walcl_4w_bn: rounded(walcl4w, 0),
    },
    note:
      `Net liquidity ${trend} ${signed(nl4w, 0)}B over 4w (driver: ${driver}) → ${wind}.`,
    flip: {
      when: nextExpected(walcl, CADENCE.weekly),
      what: `Net liquidity past ${signed(NET_LIQ_MOVE_BN, 0)}B/${signed(-NET_LIQ_MOVE_BN, 0)}B over 4w for two weekly prints; TGA building more than ${TGA_REBUILD_BN}B forces −2.`,
    },
    memory: { ...settled, weekSeen: newWeek ? weekDate : before.weekSeen ?? weekDate },
    carried: false,
    missing: feed.missing,
    stale: feed.stale,
  }
}

/**
 * Net liquidity on the balance sheet's own weekly dates, in billions.
 *
 * WALCL is published in millions and the other two in billions, which is the
 * kind of unit mismatch that produces a plausible-looking number three orders
 * of magnitude wrong.
 */
export function netLiquiditySeries(walcl, tga, rrp) {
  return walcl
    .map((row) => {
      const t = asOf(tga, row.date)
      const r = asOf(rrp, row.date)
      if (t == null || r == null) return null
      // WALCL and WTREGEN are both millions; RRPONTSYD is already billions.
      // Everything downstream is billions, and the two that need scaling must
      // both get it — see MILLIONS_TO_BN.
      return { date: row.date, value: row.value * MILLIONS_TO_BN - t * MILLIONS_TO_BN - r }
    })
    .filter(Boolean)
}

/** The latest value of `series` on or before `date`, or null if it starts later. */
export function asOf(series, date) {
  let found = null
  for (const row of series) {
    if (row.date <= date) found = row.value
    else break
  }
  return found
}

/** Change in `series` between two of the net-liquidity series' own dates. */
function alignedChange(series, anchor, back, scale = 1) {
  const now = anchor[anchor.length - 1]
  const then = anchor[anchor.length - 1 - back]
  if (!now || !then) return null

  const a = asOf(series, now.date)
  const b = asOf(series, then.date)
  return a == null || b == null ? null : (a - b) * scale
}

/** Which component moved net liquidity most, by absolute contribution. */
function largestDriver(contributions) {
  const entries = Object.entries(contributions).filter(([, v]) => Number.isFinite(v))
  if (entries.length === 0) return 'unknown'
  return entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0]
}

/* ------------------------------------------------------------------ F5 ---- */

export const HY_TIGHT_BPS = 300
export const HY_WIDE_BPS = 400
export const HY_STRESS_BPS = 600
export const HY_SPEED_BPS = 50
export const HY_RELIEF_BPS = -40
export const CREDIT_CONFIRMATIONS = 3

/**
 * Credit: high-yield option-adjusted spread, by level and by speed.
 *
 * Two rules here are deliberate and both are asymmetric.
 *
 * Tight spreads never score positive. A HY OAS under 300bps is not a tailwind,
 * it is the absence of a headwind — credit at the tights has no more room to
 * help and every bit of room to hurt, and scoring it +1 would let a complacent
 * credit market cancel out a real rates headwind.
 *
 * Speed is scored separately from level and applies immediately. Credit leads
 * equities into stress, and it does so through the rate of widening rather than
 * the level: 50bps in ten sessions from a 280 base is a louder signal than a
 * flat 380. Levels serve three closes; speed does not wait, because waiting is
 * the entire thing it exists to avoid.
 *
 * @returns {FactorResult}
 */
export function f5Credit({ series, prior, today }) {
  const ids = [SERIES.BAMLH0A0HYM2.id]
  const feed = health(series, ids, today)

  const hyPct = series[SERIES.BAMLH0A0HYM2.id] ?? []
  const igPct = series[SERIES.BAMLC0A0CM.id] ?? []

  if (!feed.ok || hyPct.length < 11) {
    return held(prior, feed, { hy_oas: rounded((lastValue(hyPct) ?? 0) * 100, 0) })
  }

  // FRED publishes both spreads in percent. Everything downstream is bps.
  const hy = lastValue(hyPct) * 100
  const ig = igPct.length ? lastValue(igPct) * 100 : null
  const hy10d = changeOverBps(hyPct, 10) ?? 0

  let bucket = 0
  if (hy > HY_STRESS_BPS) bucket = -3
  else if (hy > HY_WIDE_BPS) bucket = -2
  else if (hy >= HY_TIGHT_BPS) bucket = -1

  const before = memory(prior)
  const settled = confirm({ candidate: bucket, prior: before, confirmations: CREDIT_CONFIRMATIONS })

  // The override latches on: it survives until spreads actually retrace, rather
  // than lapsing the moment the ten-day window rolls past the widening.
  let speed = before.speed === true
  if (hy10d >= HY_SPEED_BPS) speed = true
  else if (speed && hy10d <= HY_RELIEF_BPS) speed = false

  const widening = hy10d >= 0
  const pricing = settled.state < 0 || speed ? 'pricing' : 'ignoring'

  return {
    state: settled.state + (speed ? -1 : 0),
    inputs: {
      hy_oas: rounded(hy, 0),
      ig_oas: rounded(ig, 0),
      hy_10d_bps: rounded(hy10d, 0),
      speed_override: speed,
      level_bucket: settled.state,
    },
    note:
      `HY OAS ${num(hy, 0)}bps, ${widening ? 'widening' : 'tightening'} ${num(Math.abs(hy10d), 0)}bps ` +
      `over 10 sessions: credit ${pricing} stress ahead of equities` +
      `${speed ? ' — speed override active' : ''}.`,
    flip: {
      when: nextExpected(hyPct, CADENCE.daily),
      what: speed
        ? `HY tightening ${Math.abs(HY_RELIEF_BPS)}bps over 10 sessions removes the speed override.`
        : `HY widening ${signed(HY_SPEED_BPS, 0)}bps over 10 sessions adds −1 immediately; ${HY_TIGHT_BPS}/${HY_WIDE_BPS}/${HY_STRESS_BPS}bps are the level buckets.`,
    },
    memory: { ...settled, speed },
    carried: false,
    missing: feed.missing,
    stale: feed.stale,
  }
}

/* ------------------------------------------------------------------ F6 ---- */

export const DXY_MOVE_PCT = 1.5
export const CARRY_USDJPY = 150
export const DOLLAR_CONFIRMATIONS = 5

/**
 * Dollar: the broad trade-weighted index over twenty sessions, plus a carry
 * flag on USD/JPY.
 *
 * The carry flag is a flag and not a state on purpose. USD/JPY above 150 does
 * not make today worse — it makes the tail worse, by telling you carry has
 * accumulated and that an unwind, when it comes, arrives as a gap rather than a
 * drift. Folding that into the state would have it quietly subtracting from the
 * bar every day for months while nothing happens.
 *
 * @returns {FactorResult}
 */
export function f6Dollar({ series, prior, today }) {
  const ids = [SERIES.DTWEXBGS.id]
  const feed = health(series, ids, today)

  const dxy = series[SERIES.DTWEXBGS.id] ?? []
  const jpy = series[SERIES.DEXJPUS.id] ?? []

  const dxy20d = pctChangeOver(dxy, 20)

  if (!feed.ok || dxy20d == null) {
    return held(prior, feed, { dxy_20d_pct: rounded(dxy20d, 2), usdjpy: lastValue(jpy) })
  }

  const usdjpy = lastValue(jpy)
  const carryRisk = usdjpy != null && usdjpy > CARRY_USDJPY

  let candidate = 0
  if (dxy20d <= -DXY_MOVE_PCT) candidate = 1
  else if (dxy20d >= DXY_MOVE_PCT) candidate = -1

  const settled = confirm({ candidate, prior, confirmations: DOLLAR_CONFIRMATIONS })

  const direction = dxy20d >= 0 ? 'strengthening' : 'weakening'
  const wind = settled.state < 0 ? 'headwind' : settled.state > 0 ? 'tailwind' : 'neutral'

  return {
    state: settled.state,
    inputs: {
      dxy: lastValue(dxy),
      dxy_20d_pct: rounded(dxy20d, 2),
      usdjpy,
      carry_risk: carryRisk,
    },
    note:
      `Dollar ${direction} ${num(Math.abs(dxy20d), 1)}% over 20d: ${wind} via global risk appetite ` +
      `and NQ earnings translation.` +
      (carryRisk
        ? ` USD/JPY above ${CARRY_USDJPY}: carry accumulation elevated; a fast yen rally is a de-risk signal.`
        : ''),
    flip: {
      when: nextExpected(dxy, CADENCE.daily),
      what: `Broad dollar past ±${DXY_MOVE_PCT}% over 20d for five sessions.`,
    },
    memory: settled,
    carried: false,
    missing: feed.missing,
    stale: feed.stale,
  }
}

/* ------------------------------------------------------------------ F7 ---- */

export const VIX_CALM = 20
export const VIX_HOSTILE = 30
export const RV_Z_ELEVATED = 1
export const RV_Z_HOSTILE = 2
export const VOL_EXIT_CONFIRMATIONS = 3

/** Ordinal, so the confirmation rule can compare regimes. */
export const VOL_REGIMES = ['calm', 'elevated', 'hostile']

/**
 * Vol regime: VIX level, the VIX/VIX3M term structure, and NDX realised vol as
 * a z-score against its own trailing year.
 *
 * Realised vol comes from the NASDAQ100 index close on FRED rather than from
 * NQ futures bars — same underlying, daily granularity, and it arrives through
 * the same authenticated proxy as everything else instead of needing a second
 * data path.
 *
 * The term structure earns its place by catching what the level misses. VIX at
 * 19 with VIX3M at 18 is backwardation: the market is paying more for protection
 * this month than next, which is what a genuine stress event looks like before
 * the level has caught up. A level-only rule would call that calm.
 *
 * Entering hostile is immediate and leaving takes three sessions. That
 * asymmetry is the point — the cost of being late out of a vol spike is a
 * missed day, and the cost of being early back in is the spike's second leg.
 *
 * @returns {{regime: string, inputs: object, note: string, memory: object,
 *   carried: boolean, missing: string[], stale: string[]}}
 */
export function f7Vol({ series, prior, today }) {
  // NDX is listed even though a missing close only costs the z-score: a silent
  // null there would quietly disable one third of the classifier, and a regime
  // computed from two inputs instead of three has to say so.
  const ids = [SERIES.VIXCLS.id, SERIES.VXVCLS.id, SERIES.NASDAQ100.id]
  const feed = health(series, ids, today)

  const vixSeries = series[SERIES.VIXCLS.id] ?? []
  const vix3mSeries = series[SERIES.VXVCLS.id] ?? []
  const ndx = series[SERIES.NASDAQ100.id] ?? []

  const vix = lastValue(vixSeries)
  const vix3m = lastValue(vix3mSeries)

  if (vix == null) {
    const before = carryForward(prior)
    return {
      regime: VOL_REGIMES[before.state] ?? 'elevated',
      inputs: { vix: null, vix3m: null, term: null, rv20: null, rv20_z: null },
      note: 'Vol regime carried forward — VIX unavailable.',
      memory: before,
      carried: true,
      missing: feed.missing,
      stale: feed.stale,
    }
  }

  const term = vix3m ? vix / vix3m : null
  const rv20 = realisedVol(ndx, 20)
  const rvZ = zScore(realisedVolSeries(ndx, 20))

  // A null rv_z must not block `calm`: no reading is not evidence of stress.
  let candidate
  if (vix > VIX_HOSTILE || (term != null && term > 1) || (rvZ != null && rvZ > RV_Z_HOSTILE)) {
    candidate = 2
  } else if (
    vix < VIX_CALM &&
    (term == null || term < 1) &&
    (rvZ == null || rvZ < RV_Z_ELEVATED)
  ) {
    candidate = 0
  } else {
    candidate = 1
  }

  const settled = confirm({
    candidate,
    prior,
    confirmations: VOL_EXIT_CONFIRMATIONS,
    // Escalation never waits; de-escalation always does.
    immediate: (next, current) => next > current,
  })

  const regime = VOL_REGIMES[settled.state] ?? 'elevated'
  const shape = term == null ? 'unknown' : term > 1 ? 'backwardated' : 'in contango'

  return {
    regime,
    inputs: {
      vix: rounded(vix, 2),
      vix3m: rounded(vix3m, 2),
      term: rounded(term, 3),
      rv20: rounded(rv20, 1),
      rv20_z: rounded(rvZ, 2),
    },
    note:
      `Vol ${regime}: VIX ${num(vix, 1)}, VIX3M ${num(vix3m, 1)} (${shape}), ` +
      `NDX 20d realised ${num(rv20, 1)}%${rvZ == null ? '' : ` (z ${signed(rvZ, 1)})`}.`,
    memory: settled,
    carried: false,
    missing: feed.missing,
    stale: feed.stale,
  }
}

/**
 * What the vol regime does to sizing. This is F7's effect clause, kept next to
 * the classifier that produces it rather than in the router, so there is one
 * definition of what `hostile` costs you.
 */
export function volEffect(regime) {
  if (regime === 'hostile') return { size_cap: 0.5, spm_allowed: false, mm_preferred: true }
  if (regime === 'elevated') return { size_cap: 0.75, spm_allowed: true, mm_preferred: true }
  return { size_cap: 1, spm_allowed: true, mm_preferred: false }
}

/** Days until a factor's next expected input, for the five-session watch list. */
export function daysUntil(flipWhen, today) {
  if (!flipWhen) return null
  return daysBetween(today, flipWhen)
}

/** Re-exported so the snapshot can date its own staleness checks. */
export { last, lastDate }
