/**
 * The daily snapshot: one object that Finski, the Reggie card and (later) the
 * Regime Router all read, so none of them can disagree about what the regime
 * was on a given date.
 *
 * `buildSnapshot` is a pure function of today's series, yesterday's snapshot,
 * the calendar and the harvested ISM. Yesterday's snapshot is the *only*
 * history it needs — every hysteresis counter travels inside it — which is what lets the
 * whole thing be recomputed from storage without a separate state table.
 *
 * `data_health` is mandatory, not decorative. A factor computed from a stale
 * input is indistinguishable from a factor computed from a fresh one once it
 * has been reduced to a number, so the snapshot says which is which and Finski
 * repeats it. Same fail-loud pattern as the GEX snapshot.
 */

import {
  SERIES,
  f1Growth,
  f2Inflation,
  f3Rates,
  f4Liquidity,
  f5Credit,
  f6Dollar,
  f7Vol,
  volEffect,
} from './factors.js'
import {
  FACTOR_KEYS,
  bar,
  barHistory,
  biasRaw,
  conviction,
  publishRegime,
  quadrant,
  watchList,
  windLists,
} from './compose.js'
import { classifyDay } from './events.js'
import { environment } from './environment.js'
import { harvestIsm, mergeIsmHistory } from './ism.js'
import { lastValue } from './fred.js'

export const SNAPSHOT_VERSION = 'mac-0.1'

/** Every series id the snapshot needs, for the client to request in one call. */
export const REQUIRED_SERIES = Object.values(SERIES).map((s) => s.id)

/**
 * ISM manufacturing PMI is not on FRED and has no free API — FRED's NAPM series
 * was discontinued in 2016 when ISM withdrew redistribution — so it is
 * assembled from two automated sources and then lives in the snapshot, carried
 * forward each day until the next print supersedes it. The history is kept
 * because F1 compares the level to its own three-month average, which needs
 * three prints.
 *
 * In precedence order:
 *
 *   - `actuals`, scraped from ForexFactory's calendar page by the Action into
 *     `public/data/ism_pmi.json`. The real print, on the day it lands.
 *   - the weekly feed's `previous`, which rebuilds older months for free but
 *     is permanently one release behind.
 *
 * Both are merged rather than chosen between: they cover different months, and
 * only where they overlap does the ranking decide.
 *
 * There is no manual entry. The panel used to carry one and it is gone — the
 * scrape covers the current month, and `harvestHealth` turns the panel red if
 * it stops working, which is a better guarantee than a box nobody remembers to
 * fill. Correcting a bad print means editing `ism_pmi.json`, which is committed
 * and therefore survives; a typed value only ever lived in one snapshot.
 *
 * @param {object|null} prior yesterday's snapshot
 * @param {Array<object>|null} calendar the weekly ForexFactory feed
 * @param {Array<object>|null} actuals harvested prints
 */
export function resolvePmi(prior, calendar = null, actuals = null) {
  const stored = [...(prior?.l1?.factors?.growth?.pmi_history ?? [])]
  const harvested = calendar ? harvestIsm(calendar) : null

  const history = mergeIsmHistory(stored, harvested ? [harvested] : [], actuals ?? [])

  const latest = history[history.length - 1] ?? null
  return {
    value: latest?.value ?? null,
    date: latest?.date ?? null,
    source: latest?.source ?? null,
    history,
  }
}

/** Yesterday's memory for one factor, or undefined for a first run. */
const priorMemory = (prior, key) => prior?.l1?.factors?.[key]?.memory

/**
 * Builds the snapshot for `today`.
 *
 * @param {object} input
 * @param {Record<string, Array<{date: string, value: number}>>} input.series parsed FRED series
 * @param {object|null} [input.prior] yesterday's snapshot
 * @param {Array<object>} [input.calendar] the ForexFactory weekly feed
 * @param {Array<object>} [input.ismActuals] scraped ISM prints, newest scrape wins
 * @param {string} input.today `YYYY-MM-DD`, the New York trading date
 * @param {number} [input.now] epoch ms, for the day-type session windows
 * @param {string} [input.computedAt] ISO instant
 */
export function buildSnapshot({
  series,
  prior = null,
  calendar = null,
  ismActuals = null,
  fetchErrors = {},
  today,
  now = Date.parse(`${today}T12:00:00Z`),
  computedAt,
}) {
  const pmi = resolvePmi(prior, calendar, ismActuals)

  // F7 first: conviction and the bar both scale by the vol regime, so it has to
  // exist before the composition runs.
  const vol = f7Vol({ series, prior: prior?.l2?.vol_memory, today })

  const factors = {
    growth: f1Growth({ series, prior: priorMemory(prior, 'growth'), pmi, today }),
    inflation: f2Inflation({ series, prior: priorMemory(prior, 'inflation'), today }),
    rates: f3Rates({ series, prior: priorMemory(prior, 'rates'), today }),
    liquidity: f4Liquidity({ series, prior: priorMemory(prior, 'liquidity'), today }),
    credit: f5Credit({ series, prior: priorMemory(prior, 'credit'), today }),
    dollar: f6Dollar({ series, prior: priorMemory(prior, 'dollar'), today }),
  }

  // The environment is computed beside the factors, not from them. It reads two
  // levels — the 10y real yield and net liquidity — where the factors read
  // changes, and it deliberately does not enter `bias_raw`. The bar's
  // directional claim failed validation; folding a second unvalidated claim into
  // the same number would only make the failure harder to see.
  const env = environment({ series, prior: prior?.environment?.memory, today })

  const bias = biasRaw(factors)
  const { level: convictionLevel, agreeing } = conviction(factors, bias, vol.regime)
  const barBlock = bar({ bias, convictionLevel, volRegime: vol.regime })

  const factorsChanged = FACTOR_KEYS.filter((key) => factors[key].memory?.changed).length
  const regime = publishRegime({
    label: barBlock.label,
    prior: prior?.l1?.regime,
    factorsChanged,
    today,
  })

  const { headwinds, tailwinds } = windLists(factors)
  const effect = volEffect(vol.regime)

  // With no calendar the day stays untyped rather than defaulting to `normal`:
  // "nobody checked" and "checked, nothing scheduled" must not look the same on
  // a CPI morning.
  const day = calendar
    ? classifyDay({ calendar, volRegime: vol.regime, volEffect: effect, now })
    : null

  return {
    date: today,
    computed_at: computedAt ?? new Date().toISOString(),
    version: SNAPSHOT_VERSION,

    l1: {
      quadrant: quadrant(factors.growth.state, factors.inflation.state),
      bias_raw: bias,
      conviction: convictionLevel,
      conviction_agreeing: agreeing,
      bar: {
        ...barBlock,
        history_10: barHistory(prior?.l1?.bar?.history_10, barBlock.bull_pct),
      },
      regime,
      regime_since: regime.since,
      regime_age_days: regime.age_days,
      factors: {
        growth: {
          ...serialiseFactor(factors.growth),
          pmi_history: pmi.history,
          // Which of the three sources the level in play came from. Recorded
          // because a scraped print and a typed one are the same number with
          // very different provenance, and phase 4 should be able to tell.
          pmi_source: pmi.source,
        },
        inflation: serialiseFactor(factors.inflation),
        rates: serialiseFactor(factors.rates),
        liquidity: serialiseFactor(factors.liquidity),
        credit: serialiseFactor(factors.credit),
        dollar: serialiseFactor(factors.dollar),
      },
      headwinds,
      tailwinds,
      watch: watchList(factors, today),
    },

    environment: env,

    l2: {
      vol_regime: vol.regime,
      vol_note: vol.note,
      vix: vol.inputs.vix,
      vix3m: vol.inputs.vix3m,
      term: vol.inputs.term,
      rv20: vol.inputs.rv20,
      rv20_z: vol.inputs.rv20_z,
      vol_memory: vol.memory,

      // Day typing comes from the ForexFactory feed Finski already fetches.
      // Without it the vol-only effect stands and `day_type` stays null.
      day_type: day?.day_type ?? null,
      size_cap: day?.size_cap ?? effect.size_cap,
      spm_allowed: day?.spm_allowed ?? effect.spm_allowed,
      mm_preferred: day?.mm_preferred ?? effect.mm_preferred,
      no_trade_windows: day?.no_trade_windows ?? [],
      flags: day?.flags ?? null,
      events_today: day?.events_today ?? [],
      events_next_5: day?.events_next_5 ?? [],

      // True when a calendar was fetched but does not reach today — a broken
      // refresh, or a weekly file nobody updated. Distinct from no calendar at
      // all, and reported rather than silently typed as a normal day.
      calendar_stale: day?.stale ?? false,
      feed_ends: day?.feed_ends ?? null,

      // The feed only ever holds the current week, so the five-session horizon
      // runs out on Friday. These three fields are what stop a two-session read
      // from being mistaken for a quiet week.
      horizon_sessions: day?.horizon_sessions ?? 0,
      horizon_ends: day?.horizon_ends ?? null,
      horizon_truncated: day?.horizon_truncated ?? true,
    },

    // Parked but populated: the MotiveWave panel can be added later without
    // touching mac, and in the meantime these are the numbers the live-tells
    // reference card measures the session against.
    l3_baselines: {
      dgs2: lastValue(series[SERIES.DGS2.id] ?? []),
      dxy: lastValue(series[SERIES.DTWEXBGS.id] ?? []),
      usdjpy: lastValue(series[SERIES.DEXJPUS.id] ?? []),
    },

    data_health: dataHealth(factors, vol, {
      calendar: calendar != null,
      calendarStale: day?.stale === true,
      fetchErrors,
    }),
  }
}

/** Everything about a factor that belongs in storage, in a stable key order. */
function serialiseFactor(factor) {
  return {
    state: factor.state,
    inputs: factor.inputs,
    note: factor.note,
    flip: factor.flip,
    carried: factor.carried,
    memory: factor.memory,
  }
}

/**
 * Which inputs were missing and which were too old, deduplicated across every
 * factor that reads them.
 */
export function dataHealth(
  factors,
  vol,
  { calendar = true, calendarStale = false, fetchErrors = {} } = {}
) {
  const missing = new Set()
  const stale = new Set()
  const carried = []

  // Not a FRED series, but the same rule applies: a day typed without a
  // calendar is a day nobody checked, and it has to say so. A feed that was
  // fetched but stops before today is stale rather than missing — the
  // difference tells you whether to fix the fetch or the refresh.
  if (!calendar) missing.add('CALENDAR')
  else if (calendarStale) stale.add('CALENDAR')

  for (const key of FACTOR_KEYS) {
    const factor = factors[key]
    factor.missing.forEach((id) => missing.add(id))
    factor.stale.forEach((id) => stale.add(id))
    if (factor.carried) carried.push(key)
  }

  vol.missing.forEach((id) => missing.add(id))
  vol.stale.forEach((id) => stale.add(id))
  if (vol.carried) carried.push('vol')

  return {
    missing: [...missing].sort(),
    stale: [...stale].sort(),
    carried: carried.sort(),

    // Why each series failed, in FRED's own words, stored rather than only
    // shown. The daily run happens on app load with no one watching, so
    // "missing: 18 series" with no reason attached is a dead end — the whole
    // point of failing loud is that the reason survives to be read later.
    fetch_errors: { ...fetchErrors },
  }
}

/** True when nothing was missing, stale, or carried forward. */
export const isHealthy = (snapshot) =>
  snapshot?.data_health != null &&
  snapshot.data_health.missing.length === 0 &&
  snapshot.data_health.stale.length === 0 &&
  snapshot.data_health.carried.length === 0
