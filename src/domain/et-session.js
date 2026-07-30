/**
 * Eastern-time helpers for the NY session.
 *
 * The model trades the NY AM session (09:30–12:00 ET). Rules that ask "did this
 * event land inside the session?" need those two instants as epoch ms, which
 * means knowing whether the date is EST (-05:00) or EDT (-04:00).
 *
 * DST BEHAVIOUR CHANGE vs FlowJournal. `finskiSessionWindow`
 * (trading-journal/index.html) approximated the offset as
 * `month >= 4 && month <= 10 ? '-04:00' : '-05:00'`. US DST actually begins on
 * the second Sunday in March, so that approximation reports EST for the rest of
 * March — the session window is computed an hour early, and the ELEVATED
 * "High-impact event inside AM session" rule is evaluated against the wrong
 * window. In 2026 that is 8–31 March, roughly three weeks. We read the real
 * offset from the IANA database instead, so model-risk output can differ from
 * FlowJournal's on those dates. Every other day of the year is unchanged.
 */

const NY = 'America/New_York'

/**
 * Display-only. Finski reasons entirely in New York time; CET exists solely
 * because that is where the screen is. Never compare or sort on a CET value.
 */
const CET = 'Europe/Stockholm'

/** Minutes east of UTC for New York at `instant` (EST → -300, EDT → -240). */
function etOffsetMinutes(instant) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value

  const parsed = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name ?? '')
  if (!parsed) throw new Error(`Could not read ET offset from "${name}"`)

  const [, sign, hours, minutes] = parsed
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0))
}

/** The same offset as an ISO suffix, e.g. `-04:00`. */
export function etOffset(instant) {
  const total = etOffsetMinutes(instant)
  const sign = total < 0 ? '-' : '+'
  const abs = Math.abs(total)
  const pad = (n) => String(n).padStart(2, '0')
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** The `YYYY-MM-DD` calendar date in New York at `now` (epoch ms). */
export function etDate(now) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: NY })
}

/**
 * 24-hour wall clock in `zone`. `sv-SE` rather than `en-US` with `hour12:false`,
 * which renders midnight as "24:00" in some implementations.
 */
const clock = (instant, zone) =>
  instant.toLocaleTimeString('sv-SE', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  })

/** Release time in New York, e.g. `08:30`. The zone Finski reasons in. */
export const timeET = (instant) => clock(instant, NY)

/** The same instant in Stockholm, e.g. `14:30`. Display only. */
export const timeCET = (instant) => clock(instant, CET)

/**
 * Both zones, always labelled: `08:30 ET / 14:30 CET`. Every user-visible time
 * in Finski goes through here, so no rendered time is ever bare.
 */
export const timeLabel = (instant) =>
  `${timeET(instant)} ET / ${timeCET(instant)} CET`

/**
 * NY AM session bounds for the ET date containing `now`, as epoch ms.
 *
 * @param {number} now epoch ms
 * @returns {{open: number, noon: number}} 09:30 and 12:00 ET
 */
export function nySessionWindow(now) {
  const day = etDate(now)

  // Probe at noon UTC on that ET date. DST switches at 02:00 local, and noon
  // UTC is 07:00/08:00 ET, so a single probe always lands after the switch and
  // gives the offset in force for the whole trading day — even when `now`
  // itself falls before it.
  const offset = etOffset(new Date(`${day}T12:00:00Z`))

  return {
    open: new Date(`${day}T09:30:00${offset}`).getTime(),
    noon: new Date(`${day}T12:00:00${offset}`).getTime(),
  }
}
