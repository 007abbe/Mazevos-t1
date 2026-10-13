/**
 * The tick collector: how far price moved for or against you, in ticks, summed.
 *
 * A trade's ticks are signed by direction, from prices the journal already
 * records:
 *
 *   Long   (actual_exit - entry_price) / TICK_SIZE
 *   Short  (entry_price - actual_exit) / TICK_SIZE
 *
 * so a 200-tick winner and a 100-tick loser collect +100. Per trade, not per
 * contract — like points.js this describes the chart, and there is no size
 * column to multiply by anyway.
 *
 * Every trade is NQ (see `tradeLabel`), so one tick size. `x` is excluded by
 * name rather than by its missing prices: it is the model that records no
 * levels, and an `x` row that happened to carry an entry should not start
 * counting. Vetoes were never filled, so they have no ticks either.
 */

import { isVeto } from './veto-vocab.js'

export const TICK_SIZE = 0.25

/**
 * The furthest an NQ trade can plausibly travel, entry to exit: 1,000 points,
 * about 4% of the index and well past any session's range. Anything beyond is
 * a mistyped price — `2490` for `24900` is 22,000 points, ~90,000 ticks, and
 * one such row would swamp the whole collector. Those rows are held out and
 * named instead, so the number stays honest and the typo gets fixed.
 */
export const MAX_TRADE_POINTS = 1000
const MAX_TRADE_TICKS = MAX_TRADE_POINTS / TICK_SIZE

/** Models whose trades do not collect. */
const UNCOUNTED_MODELS = new Set(['x'])

const price = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * A trade's signed ticks, or null when it does not count: a veto, an `x`
 * trade, an open trade with no exit, or a row missing a price or a direction.
 *
 * Rounded to a whole tick. Prices arrive as numeric strings and 19900.75 -
 * 19900 is not exactly 0.75 in floating point; a tick count of 2.9999999 would
 * print as one.
 */
export function tradeTicks(trade) {
  if (!trade || isVeto(trade)) return null
  if (UNCOUNTED_MODELS.has(trade.model)) return null

  const entry = price(trade.entry_price)
  const exit = price(trade.actual_exit)
  if (entry === null || exit === null) return null

  const sign = trade.type === 'Long' ? 1 : trade.type === 'Short' ? -1 : 0
  if (!sign) return null

  return Math.round((sign * (exit - entry)) / TICK_SIZE)
}

/** True when a trade's ticks are too far to be anything but a typo. */
export const isSuspectTicks = (ticks) => ticks !== null && Math.abs(ticks) > MAX_TRADE_TICKS

/**
 * The collector over a set of trades. `n` is how many counted, which is rarely
 * all of them — rows from before entry prices were recorded have none.
 * `suspect` holds the trades left out for an implausible distance.
 */
export function tickTally(trades = []) {
  const suspect = []
  const ticks = []
  for (const t of trades) {
    const v = tradeTicks(t)
    if (v === null) continue
    if (isSuspectTicks(v)) suspect.push(t)
    else ticks.push(v)
  }
  const gained = ticks.filter((t) => t > 0).reduce((a, b) => a + b, 0)
  const lost = ticks.filter((t) => t < 0).reduce((a, b) => a + b, 0)

  return {
    net: gained + lost,
    gained,
    lost,
    n: ticks.length,
    best: ticks.length ? Math.max(...ticks) : null,
    worst: ticks.length ? Math.min(...ticks) : null,
    suspect,
  }
}

/** `+120`, `-40`, `0` — the sign is the point of the number. */
export const fmtTicks = (n) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`)

/*
 * ---- Periods ----
 *
 * `date` is a `YYYY-MM-DDTHH:mm` string in the trader's local time, so a period
 * is a pair of `YYYY-MM-DD` bounds compared as strings — the same trick
 * filters.js uses for sorting, and it never builds a Date per row.
 */

export const TICK_PERIODS = [
  { value: 'all', label: 'All-time' },
  { value: 'month', label: 'This month' },
  { value: 'week', label: 'This week' },
  { value: 'custom', label: 'Custom' },
]

const pad = (n) => String(n).padStart(2, '0')
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Inclusive `{ from, to }` day bounds for a period, either of which may be
 * null for open-ended. Weeks start on Monday — a trading week, not a calendar
 * one that would split Friday from the Monday before it.
 */
export function periodRange(period, now = new Date(), custom = {}) {
  if (period === 'month') {
    return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: null }
  }
  if (period === 'week') {
    const back = (now.getDay() + 6) % 7 // Monday = 0
    return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)), to: null }
  }
  if (period === 'custom') return { from: custom.from || null, to: custom.to || null }
  return { from: null, to: null }
}

/** Trades whose day falls inside the range. A trade with no date is in "all" only. */
export function inRange(trades = [], { from, to } = {}) {
  if (!from && !to) return trades
  return trades.filter((t) => {
    const day = String(t.date ?? '').slice(0, 10)
    if (!day) return false
    if (from && day < from) return false
    if (to && day > to) return false
    return true
  })
}
