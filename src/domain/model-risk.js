/**
 * Model-risk rules for the Finski pre-market brief.
 *
 * The risk level is decided here and nowhere else: deterministic rules over the
 * economic calendar, VIX/VVIX, and yesterday's tagged day type. The LLM writes
 * prose around this verdict — it never sets, softens, or argues with it.
 * Ported from trading-journal/index.html (`finskiModelRisk`).
 *
 * Agent-agnostic and UI-free: no DOM, no fetch, no clock. `now` is injected so
 * the time-sensitive rules (pre/post release, digestion window, session bounds)
 * are testable.
 */

import { etDate, nySessionWindow } from './et-session.js'

/**
 * A calendar event, as `src/agents/finski/calendar.js` shapes it. Only USD
 * High/Medium events reach the rules.
 *
 * @typedef {object} CalendarEvent
 * @property {string} title
 * @property {'High'|'Medium'} impact
 * @property {Date} dt scheduled release instant — the only comparable time
 * @property {string} timeLabel pre-formatted `08:30 ET / 14:30 CET`, quoted in
 *   rule text. Rules compare on `dt`; they never parse a formatted time.
 */

/** Ordered least to most severe; a rule may raise the level, never lower it. */
export const LEVELS = ['LOW', 'ELEVATED', 'HIGH']

const RANK = Object.fromEntries(LEVELS.map((level, i) => [level, i]))

/** Releases that reprice the whole curve — the model has no edge around them. */
export const MAJOR_RELEASE =
  /CPI|Consumer Price|Nonfarm|Non-Farm|NFP|PPI|Producer Price/i

export const FOMC =
  /Federal Funds Rate|FOMC Statement|FOMC Press Conference|FOMC Economic Projections/i

/**
 * Second-tier inflation prints. Real market movers, but a step below the
 * top-tier releases above — so they carry their own ELEVATED rule rather than
 * joining MAJOR_RELEASE, which drives the HIGH "not yet released" path.
 *
 * Growth prints (Advance GDP and friends) are deliberately out: they move the
 * tape, but not the way an inflation surprise does.
 */
export const SECOND_TIER_INFLATION = /Core PCE|PCE Price Index/i

export const VIX_HIGH = 28
export const VIX_ELEVATED_FLOOR = 20
/** Day-over-day VIX change, in percent, that counts as a spike. */
export const VIX_SPIKE_PCT = 15
export const VVIX_ELEVATED = 110
/** How long the tape needs to absorb a major release. */
export const DIGESTION_MS = 30 * 60 * 1000

/**
 * The day type that carries regime risk into the next session. Asserted against
 * `trade-vocab.js` in the tests so a vocabulary rename can't silently mute this
 * rule.
 */
export const PERSISTENT_DAY_TYPE = 'Trend Day'

/**
 * @param {object} input
 * @param {CalendarEvent[]} [input.events] today's USD High/Medium events
 * @param {{now: number|null, prev: number|null}} input.vix
 * @param {number|null} [input.vvix]
 * @param {{date: string, day_type: string|null, regime: string|null}|null} [input.yesterday]
 * @param {number} input.now epoch ms
 * @returns {{level: 'LOW'|'ELEVATED'|'HIGH', triggered: string[]}}
 */
export function computeModelRisk({
  events = [],
  vix,
  vvix = null,
  yesterday = null,
  now,
}) {
  if (!Number.isFinite(now)) {
    throw new TypeError('computeModelRisk needs `now` as epoch ms')
  }

  const session = nySessionWindow(now)
  const triggered = []
  let level = 'LOW'

  const bump = (candidate, rule) => {
    triggered.push(rule)
    if (RANK[candidate] > RANK[level]) level = candidate
  }

  const vixNow = vix?.now ?? null
  const vixPrev = vix?.prev ?? null

  // --- HIGH ---------------------------------------------------------------

  if (events.some((e) => FOMC.test(e.title))) {
    bump('HIGH', 'FOMC decision day')
  }

  // Unreleased major print: the whole session is a coin flip until it lands.
  events
    .filter(
      (e) =>
        MAJOR_RELEASE.test(e.title) &&
        e.impact === 'High' &&
        e.dt.getTime() > now
    )
    .forEach((e) =>
      bump('HIGH', `${e.title} not yet released (${e.timeLabel})`)
    )

  if (vixNow != null && vixNow > VIX_HIGH) {
    bump('HIGH', `VIX ${vixNow} > ${VIX_HIGH}`)
  }

  if (vixNow != null && vixPrev != null) {
    const change = ((vixNow - vixPrev) / vixPrev) * 100
    if (change >= VIX_SPIKE_PCT) {
      bump('HIGH', `VIX +${change.toFixed(1)}% d/d (≥${VIX_SPIKE_PCT}%)`)
    }
  }

  // --- ELEVATED -----------------------------------------------------------

  events
    .filter(
      (e) =>
        e.impact === 'High' &&
        e.dt.getTime() >= session.open &&
        e.dt.getTime() <= session.noon
    )
    .forEach((e) =>
      bump('ELEVATED', `${e.title} inside AM session (${e.timeLabel})`)
    )

  events
    .filter((e) => MAJOR_RELEASE.test(e.title) && e.impact === 'High')
    .forEach((e) => {
      const ago = now - e.dt.getTime()
      if (ago > 0 && ago < DIGESTION_MS) {
        bump(
          'ELEVATED',
          `${e.title} released ${Math.round(ago / 60000)} min ago (<30 min digestion)`
        )
      }
    })

  // Second-tier inflation, pre-release only: the same shape as the tier-one
  // "not yet released" rule, one level down.
  events
    .filter(
      (e) =>
        SECOND_TIER_INFLATION.test(e.title) &&
        e.impact === 'High' &&
        e.dt.getTime() > now
    )
    .forEach((e) =>
      bump(
        'ELEVATED',
        `${e.title} not yet released (${e.timeLabel}) — second-tier inflation print`
      )
    )

  if (vixNow != null && vixNow >= VIX_ELEVATED_FLOOR && vixNow <= VIX_HIGH) {
    bump('ELEVATED', `VIX ${vixNow} in ${VIX_ELEVATED_FLOOR}–${VIX_HIGH} band`)
  }

  if (vvix != null && vvix > VVIX_ELEVATED) {
    bump('ELEVATED', `VVIX ${vvix} > ${VVIX_ELEVATED}`)
  }

  if (yesterday?.day_type === PERSISTENT_DAY_TYPE) {
    bump('ELEVATED', `Yesterday tagged ${PERSISTENT_DAY_TYPE} (regime persistence)`)
  }

  return { level, triggered }
}

/**
 * Most recent prior day carrying a day_type or regime tag, for the regime
 * persistence rule. Replaces FlowJournal's `finskiYesterdayContext`, which read
 * a module-global `trades` array; trades are passed in here instead.
 *
 * "Today" is the ET date, not the UTC one FlowJournal used. Between 19:00 ET
 * and midnight the UTC date has already rolled over, so FlowJournal counted the
 * current session's own trades as a prior day.
 *
 * @param {Array<{date?: string, day_type?: string, regime?: string}>} trades
 * @param {number} now epoch ms
 */
export function yesterdayContext(trades, now) {
  const today = etDate(now)

  const prior = trades
    .filter((t) => t.date && t.date.slice(0, 10) < today && (t.day_type || t.regime))
    .sort((a, b) => new Date(b.date) - new Date(a.date))

  if (!prior.length) return null

  return {
    date: prior[0].date.slice(0, 10),
    day_type: prior[0].day_type || null,
    regime: prior[0].regime || null,
  }
}

