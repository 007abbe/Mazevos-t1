/**
 * Stop and target distances, in points.
 *
 * Points, not dollars and not R. Dollars depend on size and R depends on where
 * the stop went, so both move when your risk changes — points are the only one
 * of the three that describes the *chart*. "My stops average 18 points" is a
 * statement about how you read structure; "my stops average $45" is a statement
 * about your position sizer.
 *
 * Every distance is derived from prices the journal already records, so nothing
 * here needs a new column:
 *
 *   stop   = |entry_price - planned_stop|   where the trade planned a stop
 *   target = |actual_exit - entry_price|    on winners only
 *
 * Targets come from the realised exit rather than the `target` column because
 * that column is free text — it holds "VWAP" and "Major putwall" as often as a
 * level, so it cannot be subtracted from anything.
 */

const price = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

/**
 * How far the stop sat from the entry, in points, or null when the trade did
 * not record both prices.
 *
 * A zero distance is null too: entry and stop at the same price is a data entry
 * slip, not a zero-risk trade, and averaging it in would drag the mean toward a
 * stop size nobody ever used.
 */
export function stopPoints(trade) {
  const entry = price(trade?.entry_price)
  const stop = price(trade?.planned_stop)
  if (entry === null || stop === null) return null

  const distance = Math.abs(entry - stop)
  return distance > 0 ? distance : null
}

/**
 * How far the exit ran from the entry, in points, on winners only.
 *
 * Losers are excluded deliberately: the distance from entry to a stopped-out
 * exit is a stop, not a target, and averaging the two together would produce a
 * number that describes neither. What this answers is "when it works, how far
 * do I actually take it".
 */
export function takeProfitPoints(trade) {
  if (Number(trade?.pnl ?? 0) <= 0) return null

  const entry = price(trade?.entry_price)
  const exit = price(trade?.actual_exit)
  if (entry === null || exit === null) return null

  const distance = Math.abs(exit - entry)
  return distance > 0 ? distance : null
}

/**
 * Stop and target distances across a set of trades.
 *
 * Each group carries its own `n`, and they are rarely the same number: every
 * trade can have a stop, only winners have a target. Reporting one sample size
 * for both would misrepresent whichever is smaller.
 *
 * `ratio` is the realised reward-to-risk *in points* — average target over
 * average stop. It is not the `rr` column, which is what the trade was planned
 * at, and the two diverging is itself the finding.
 */
export function pointStats(trades = []) {
  const stops = trades.map(stopPoints).filter((v) => v !== null)
  const targets = trades.map(takeProfitPoints).filter((v) => v !== null)

  const avgStop = mean(stops)
  const avgTarget = mean(targets)

  return {
    avgStop,
    stopN: stops.length,
    minStop: stops.length ? Math.min(...stops) : null,
    maxStop: stops.length ? Math.max(...stops) : null,
    avgTarget,
    targetN: targets.length,
    ratio: avgStop && avgTarget ? avgTarget / avgStop : null,
  }
}
