/**
 * The daily snapshot: one object that Finski, the Reggie card and (later) the
 * Regime Router all read, so none of them can disagree about what the regime
 * was on a given date.
 *
 * `buildSnapshot` is a pure function of today's series, yesterday's snapshot,
 * and the manually-entered ISM. Yesterday's snapshot is the *only* history it
 * needs — every hysteresis counter travels inside it — which is what lets the
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
import { harvestIsm, mergeIsmHistory } from './ism.js'
import { lastValue } from './fred.js'

export const SNAPSHOT_VERSION = 'mac-0.1'

/** Every series id the snapshot needs, for the client to request in one call. */
export const REQUIRED_SERIES = Object.values(SERIES).map((s) => s.id)

/**
 * ISM manufacturing PMI is not on FRED and has no free API, so it is typed in
 * on release day and then lives in the snapshot, carried forward each day until
 * the next print supersedes it. The history is kept because F1 compares the
 * level to its own three-month average, which needs three prints.
 *
 * @param {object|null} prior yesterday's snapshot
 * @param {{value: number, date: string}|null} entry today's manual entry
 */
export function resolvePmi(prior, entry, calendar = null) {
  let history = [...(prior?.l1?.factors?.growth?.pmi_history ?? [])]

  // The feed's `previous` on an ISM row is the prior month's true print, so the
  // history fills itself in permanently one release behind. A typed entry for
  // the same month always wins — see `mergeIsmHistory`.
  const harvested = calendar ? harvestIsm(calendar) : null
  if (harvested) history = mergeIsmHistory(history, [harvested])

  if (entry && Number.isFinite(entry.value) && entry.date) {
    const existing = history.findIndex((row) => row.date === entry.date)
    if (existing >= 0) history[existing] = { date: entry.date, value: entry.value }
    else history.push({ date: entry.date, value: entry.value })
    history.sort((a, b) => (a.date < b.date ? -1 : 1))
  }

  const latest = history[history.length - 1] ?? null
  return { value: latest?.value ?? null, date: latest?.date ?? null, history }
}

/** Yesterday's memory for one factor, or undefined for a first run. */
const priorMemory = (prior, key) => prior?.l1?.factors?.[key]?.memory

/**
 * Builds the snapshot for `today`.
 *
 * @param {object} input
 * @param {Record<string, Array<{date: string, value: number}>>} input.series parsed FRED series
 * @param {object|null} [input.prior] yesterday's snapshot
 * @param {{value: number, date: string}|null} [input.pmiEntry] manual ISM entry
 * @param {Array<object>} [input.calendar] the ForexFactory weekly feed
 * @param {string} input.today `YYYY-MM-DD`, the New York trading date
 * @param {number} [input.now] epoch ms, for the day-type session windows
 * @param {string} [input.computedAt] ISO instant
 */
export function buildSnapshot({
  series,
  prior = null,
  pmiEntry = null,
  calendar = null,
  fetchErrors = {},
  today,
  now = Date.parse(`${today}T12:00:00Z`),
  computedAt,
}) {
  const pmi = resolvePmi(prior, pmiEntry, calendar)

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
        growth: { ...serialiseFactor(factors.growth), pmi_history: pmi.history },
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
