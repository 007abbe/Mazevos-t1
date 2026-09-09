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
 * They do share the post-release digestion window: these move the tape the way
 * CPI does, and the first half hour after the print is when that happens. The
 * tier difference is how bad an unreleased one is, not how the tape behaves
 * once it lands.
 *
 * Growth prints (Advance GDP and friends) are deliberately out: they move the
 * tape, but not the way an inflation surprise does.
 */
export const SECOND_TIER_INFLATION = /Core PCE|PCE Price Index/i

/**
 * Prints whose release the tape needs time to absorb. Both tiers qualify — the
 * digestion window is about what just happened, not about what was scheduled.
 */
const needsDigestion = (event) =>
  (MAJOR_RELEASE.test(event.title) || SECOND_TIER_INFLATION.test(event.title)) &&
  event.impact === 'High'

/**
 * Volatility thresholds, on VXN rather than VIX.
 *
 * You trade NQ, and VXN is the Nasdaq-100's own volatility index — VIX is the
 * S&P's. Reading S&P vol to size a Nasdaq trade works only while the two move
 * together, which is exactly the assumption that fails on a tech-led drawdown.
 *
 * **The levels are not the VIX numbers reused.** VXN runs structurally higher:
 * over 2012-2026 its median is 19.4 against VIX's 16.2, so a straight swap would
 * have put an ordinary Tuesday inside the elevated band. Each threshold is set
 * to the VXN level at the *same percentile* the VIX one sat at, which preserves
 * how often the rule fires rather than the number it fires at:
 *
 *   VIX 20 → p75.0 → VXN 24.4 → 24
 *   VIX 28 → p94.0 → VXN 33.4 → 33
 *   VIX +15% d/d → p96.1 → VXN +12.3% → 12
 *
 * The spike rule needed rescaling too even though a percentage looks
 * scale-free: a higher base makes the same percentage a rarer event, and VIX
 * cleared 15% on 147 days where VXN managed only 90.
 */
export const VXN_HIGH = 33
export const VXN_ELEVATED_FLOOR = 24
/** Day-over-day VXN change, in percent, that counts as a spike. */
export const VXN_SPIKE_PCT = 12

/**
 * VVIX has no Nasdaq counterpart, so it stays as it is.
 *
 * It measures the vol of VIX itself and is a read on the whole volatility
 * complex rather than on one index, which is still worth having beside VXN.
 */
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
 * @param {{now: number|null, prev: number|null}} input.vxn
 * @param {number|null} [input.vvix]
 * @param {{date: string, day_type: string|null, regime: string|null}|null} [input.yesterday]
 * @param {number} input.now epoch ms
 * @returns {{level: 'LOW'|'ELEVATED'|'HIGH', triggered: string[]}}
 */
export function computeModelRisk({
  events = [],
  vxn,
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

  const vxnNow = vxn?.now ?? null
  const vxnPrev = vxn?.prev ?? null

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

  if (vxnNow != null && vxnNow > VXN_HIGH) {
    bump('HIGH', `VXN ${vxnNow} > ${VXN_HIGH}`)
  }

  if (vxnNow != null && vxnPrev != null) {
    const change = ((vxnNow - vxnPrev) / vxnPrev) * 100
    if (change >= VXN_SPIKE_PCT) {
      bump('HIGH', `VXN +${change.toFixed(1)}% d/d (≥${VXN_SPIKE_PCT}%)`)
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
    .filter(needsDigestion)
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

  if (vxnNow != null && vxnNow >= VXN_ELEVATED_FLOOR && vxnNow <= VXN_HIGH) {
    bump('ELEVATED', `VXN ${vxnNow} in ${VXN_ELEVATED_FLOOR}–${VXN_HIGH} band`)
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

