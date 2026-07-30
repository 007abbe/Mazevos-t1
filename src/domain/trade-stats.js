/**
 * Deterministic trade statistics — DOM's Layer 1.
 *
 * Every number DOM reports is computed here. The model interprets these
 * figures and never calculates its own: that separation is the whole point of
 * the two-layer design, so this module owns arithmetic and owns it alone.
 * Ported from trading-journal/index.html (`computeDomStats`).
 *
 * Pure and agent-agnostic: no DOM, no fetch, no clock. Trades must already be
 * mapped through `fromRow` — Postgres returns numerics as strings, and string
 * arithmetic here would be silently wrong rather than loud.
 */

/** Below this, a group is not reportable — only listable as insufficient. */
export const MIN_SAMPLE = 5

/** Up to this, a group is reportable but only as a provisional signal. */
export const EARLY_SIGNAL_MAX = 9

export const DELAY_BUCKETS = ['0-10s', '10-30s', '30s+']

const round = (value, places) => Number(value.toFixed(places))

/**
 * Realised R. Null when risk is missing or zero — an R-multiple against no
 * declared risk is meaningless, and dividing by it would poison every average
 * downstream.
 */
export function rMultiple(trade) {
  return trade.risk > 0 ? trade.pnl / trade.risk : null
}

/**
 * Aggregate one group of trades.
 *
 * `insufficient` and `earlySignal` are carried as data rather than left for the
 * model to derive: DOM's sample-size rule is then something it reads, not
 * arithmetic it performs, and the threshold lives in one place instead of being
 * restated in prompt prose.
 */
export function aggregate(list) {
  const n = list.length
  const rs = list.map(rMultiple).filter((r) => r != null)
  const wins = list.filter((t) => t.pnl > 0).length
  const losses = list.filter((t) => t.pnl < 0).length
  const totalR = rs.reduce((sum, r) => sum + r, 0)

  return {
    n,
    wins,
    losses,
    be: n - wins - losses,
    winRate: n ? round((wins / n) * 100, 1) : null,
    avgR: rs.length ? round(totalR / rs.length, 2) : null,
    totalR: rs.length ? round(totalR, 2) : null,
    // avgR is averaged over rSample, not n — trades with no declared risk have
    // no R. Without this the model would read avgR as covering the whole group.
    rSample: rs.length,
    insufficient: n < MIN_SAMPLE,
    earlySignal: n >= MIN_SAMPLE && n <= EARLY_SIGNAL_MAX,
  }
}

/** Groups by `key(trade)`, with null/undefined collected under `untagged`. */
export function groupBy(list, key) {
  const groups = {}
  for (const trade of list) {
    const k = key(trade) ?? 'untagged'
    ;(groups[k] ??= []).push(trade)
  }

  return Object.fromEntries(
    Object.entries(groups).map(([k, trades]) => [k, aggregate(trades)])
  )
}

const delayBucket = (trade) => {
  if (trade.entry_delay_sec == null) return null
  if (trade.entry_delay_sec <= 10) return DELAY_BUCKETS[0]
  if (trade.entry_delay_sec <= 30) return DELAY_BUCKETS[1]
  return DELAY_BUCKETS[2]
}

/**
 * Trades taken after two or more consecutive losses — the tilt sequence.
 * Chronological, so a mis-sorted input would silently measure the wrong thing.
 */
function afterTwoLosses(chronological) {
  return chronological.filter(
    (_, i) =>
      i >= 2 && chronological[i - 1].pnl < 0 && chronological[i - 2].pnl < 0
  )
}

/** Count and cumulative R cost per broken rule, keyed by the stored value. */
function ruleBrokenCost(chronological) {
  const rules = {}

  for (const trade of chronological) {
    const r = rMultiple(trade)
    for (const rule of trade.rule_broken ?? []) {
      rules[rule] ??= { count: 0, totalR: 0 }
      rules[rule].count++
      if (r != null) rules[rule].totalR += r
    }
  }

  // Rounded once at the end. FlowJournal rounded on every addition, which
  // accumulated drift across a long selection.
  for (const rule of Object.values(rules)) rule.totalR = round(rule.totalR, 2)

  return rules
}

/**
 * The full statistics object DOM reasons over.
 *
 * @param {Array<object>} trades mapped trades (see `fromRow`)
 */
export function computeTradeStats(trades) {
  // `date` is 'YYYY-MM-DDTHH:mm' text, so lexicographic order is chronological
  // order — no Date parsing, no timezone in the comparison.
  const chronological = [...trades].sort((a, b) =>
    (a.date ?? '').localeCompare(b.date ?? '')
  )

  return {
    overall: aggregate(chronological),
    bySetup: groupBy(chronological, (t) => t.setup_type),
    byAwayStack: groupBy(chronological, (t) => (t.away_stack ? 'with_stack' : 'no_stack')),
    byBand: groupBy(chronological, (t) => t.band_touched),
    byRegime: groupBy(chronological, (t) => t.regime),
    byTarget: groupBy(chronological, (t) => t.target),
    byDayType: groupBy(chronological, (t) => t.day_type),
    byEntryDelay: groupBy(
      chronological.filter((t) => t.entry_delay_sec != null),
      delayBucket
    ),
    beFear: aggregate(chronological.filter((t) => t.be_reason === 'fear')),
    beStructure: aggregate(chronological.filter((t) => t.be_reason === 'structure')),
    newsWindow: aggregate(chronological.filter((t) => t.news_window)),
    afterTwoLosses: aggregate(afterTwoLosses(chronological)),
    ruleBroken: ruleBrokenCost(chronological),
    untaggedCount: chronological.filter((t) => !t.setup_type).length,
    thresholds: { minSample: MIN_SAMPLE, earlySignalMax: EARLY_SIGNAL_MAX },
  }
}
