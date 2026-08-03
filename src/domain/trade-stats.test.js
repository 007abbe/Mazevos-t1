import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregate,
  computeTradeStats,
  groupBy,
  groupByEach,
  rMultiple,
  EARLY_SIGNAL_MAX,
  MIN_SAMPLE,
} from './trade-stats.js'
import { fromRow } from '../journal/mapping.js'
import { RULE_BROKEN_VALUES } from './trade-vocab.js'

let seq = 0

/** A mapped trade, as `fromRow` produces one. */
const trade = (overrides = {}) => ({
  id: `t${++seq}`,
  num: seq,
  date: `2026-07-${String(10 + (seq % 20)).padStart(2, '0')}T15:30`,
  pnl: 100,
  risk: 50,
  setup_type: 'A',
  band_touched: ['-2σ'],
  away_stack: true,
  target: ['VWAP'],
  regime: 'balance',
  day_type: 'Normal Day',
  be_reason: null,
  news_window: false,
  entry_delay_sec: null,
  rule_broken: [],
  ...overrides,
})

/** `n` trades that trip no thresholds, for padding a group to a given size. */
const filler = (n, overrides = {}) =>
  Array.from({ length: n }, () => trade(overrides))

// --- rMultiple ------------------------------------------------------------

test('rMultiple is P&L over declared risk', () => {
  assert.equal(rMultiple(trade({ pnl: 100, risk: 50 })), 2)
  assert.equal(rMultiple(trade({ pnl: -75, risk: 50 })), -1.5)
  assert.equal(rMultiple(trade({ pnl: 0, risk: 50 })), 0)
})

test('rMultiple is null without usable risk, never Infinity', () => {
  assert.equal(rMultiple(trade({ pnl: 100, risk: 0 })), null)
  assert.equal(rMultiple(trade({ pnl: 100, risk: -50 })), null)
})

// --- aggregate ------------------------------------------------------------

test('an empty group reports nulls, not zeroes', () => {
  const stats = aggregate([])

  assert.equal(stats.n, 0)
  assert.equal(stats.winRate, null, '0% would claim a measured 0% win rate')
  assert.equal(stats.avgR, null)
  assert.equal(stats.totalR, null)
  assert.equal(stats.insufficient, true)
})

test('breakeven is anything that is neither a win nor a loss', () => {
  const stats = aggregate([
    trade({ pnl: 100 }),
    trade({ pnl: -50 }),
    trade({ pnl: 0 }),
  ])

  assert.equal(stats.wins, 1)
  assert.equal(stats.losses, 1)
  assert.equal(stats.be, 1)
  assert.equal(stats.n, 3)
})

test('win rate is a percentage to one decimal', () => {
  const stats = aggregate([
    trade({ pnl: 100 }),
    trade({ pnl: 100 }),
    trade({ pnl: -50 }),
  ])
  assert.equal(stats.winRate, 66.7)
})

test('R figures average over the trades that have R, and say so', () => {
  const stats = aggregate([
    trade({ pnl: 100, risk: 50 }), // +2R
    trade({ pnl: -50, risk: 50 }), // -1R
    trade({ pnl: 400, risk: 0 }), // no declared risk — excluded from R
  ])

  assert.equal(stats.n, 3)
  assert.equal(stats.rSample, 2, 'the R denominator differs from n')
  assert.equal(stats.totalR, 1)
  assert.equal(stats.avgR, 0.5, 'averaged over 2, not 3')
})

test('R figures round to two decimals', () => {
  const stats = aggregate([
    trade({ pnl: 100, risk: 30 }),
    trade({ pnl: 100, risk: 30 }),
    trade({ pnl: 100, risk: 30 }),
  ])
  assert.equal(stats.avgR, 3.33)
  assert.equal(stats.totalR, 10)
})

test('sample-size flags are carried as data, at the documented boundaries', () => {
  const flags = (n) => {
    const { insufficient, earlySignal } = aggregate(filler(n))
    return { insufficient, earlySignal }
  }

  assert.deepEqual(flags(MIN_SAMPLE - 1), { insufficient: true, earlySignal: false })
  assert.deepEqual(flags(MIN_SAMPLE), { insufficient: false, earlySignal: true })
  assert.deepEqual(flags(EARLY_SIGNAL_MAX), { insufficient: false, earlySignal: true })
  assert.deepEqual(flags(EARLY_SIGNAL_MAX + 1), { insufficient: false, earlySignal: false })
})

// --- groupBy --------------------------------------------------------------

test('groupBy aggregates each key independently', () => {
  const groups = groupBy(
    [
      trade({ setup_type: 'A', pnl: 100 }),
      trade({ setup_type: 'A', pnl: 100 }),
      trade({ setup_type: 'B', pnl: -50 }),
    ],
    (t) => t.setup_type
  )

  assert.equal(groups.A.n, 2)
  assert.equal(groups.A.winRate, 100)
  assert.equal(groups.B.n, 1)
  assert.equal(groups.B.winRate, 0)
})

test('an absent tag groups under untagged rather than vanishing', () => {
  const groups = groupBy(
    [trade({ setup_type: null }), trade({ setup_type: undefined }), trade({ setup_type: 'A' })],
    (t) => t.setup_type
  )

  assert.equal(groups.untagged.n, 2)
  assert.equal(groups.A.n, 1)
})

test('a falsy-but-real key is not mistaken for untagged', () => {
  const groups = groupBy([trade({ away_stack: false })], (t) =>
    t.away_stack ? 'with_stack' : 'no_stack'
  )

  assert.deepEqual(Object.keys(groups), ['no_stack'])
})

// --- computeTradeStats ----------------------------------------------------

test('afterTwoLosses picks up every trade following two consecutive losses', () => {
  // L L W L L L W  ->  the 3rd trade, plus the 6th and 7th
  const pnls = [-50, -50, 100, -50, -50, -50, 100]
  const trades = pnls.map((pnl, i) => trade({ pnl, date: `2026-07-0${i + 1}T15:30` }))

  assert.equal(computeTradeStats(trades).afterTwoLosses.n, 3)
})

test('afterTwoLosses is chronological regardless of input order', () => {
  const chronological = [-50, -50, 100].map((pnl, i) =>
    trade({ pnl, date: `2026-07-0${i + 1}T15:30` })
  )
  const shuffled = [chronological[2], chronological[0], chronological[1]]

  assert.equal(computeTradeStats(shuffled).afterTwoLosses.n, 1)
  assert.deepEqual(
    computeTradeStats(shuffled).afterTwoLosses,
    computeTradeStats(chronological).afterTwoLosses
  )
})

test('a breakeven between two losses breaks the sequence', () => {
  const pnls = [-50, 0, -50, 100]
  const trades = pnls.map((pnl, i) => trade({ pnl, date: `2026-07-0${i + 1}T15:30` }))

  assert.equal(computeTradeStats(trades).afterTwoLosses.n, 0)
})

test('rule breaks accumulate count and R cost per rule', () => {
  const [first, second] = RULE_BROKEN_VALUES

  const stats = computeTradeStats([
    trade({ pnl: -50, risk: 50, rule_broken: [first, second] }),
    trade({ pnl: -100, risk: 50, rule_broken: [first] }),
    trade({ pnl: 100, risk: 50, rule_broken: [] }),
  ])

  assert.deepEqual(stats.ruleBroken[first], { count: 2, totalR: -3 })
  assert.deepEqual(stats.ruleBroken[second], { count: 1, totalR: -1 })
})

test('a rule break on a trade with no risk still counts, without skewing R', () => {
  const [rule] = RULE_BROKEN_VALUES

  const stats = computeTradeStats([
    trade({ pnl: -50, risk: 0, rule_broken: [rule] }),
    trade({ pnl: -50, risk: 50, rule_broken: [rule] }),
  ])

  assert.deepEqual(stats.ruleBroken[rule], { count: 2, totalR: -1 })
})

test('entry delay buckets split at their documented boundaries', () => {
  const stats = computeTradeStats([
    trade({ entry_delay_sec: 0 }),
    trade({ entry_delay_sec: 10 }),
    trade({ entry_delay_sec: 11 }),
    trade({ entry_delay_sec: 30 }),
    trade({ entry_delay_sec: 31 }),
    trade({ entry_delay_sec: null }),
  ])

  assert.equal(stats.byEntryDelay['0-10s'].n, 2)
  assert.equal(stats.byEntryDelay['10-30s'].n, 2)
  assert.equal(stats.byEntryDelay['30s+'].n, 1)
  assert.ok(
    !('untagged' in stats.byEntryDelay),
    'untimed trades are excluded, not bucketed as untagged'
  )
})

test('BE reasons, news window and untagged count are broken out', () => {
  const stats = computeTradeStats([
    trade({ be_reason: 'fear', pnl: 0 }),
    trade({ be_reason: 'fear', pnl: 0 }),
    trade({ be_reason: 'structure', pnl: 0 }),
    trade({ news_window: true }),
    trade({ setup_type: null }),
  ])

  assert.equal(stats.beFear.n, 2)
  assert.equal(stats.beStructure.n, 1)
  assert.equal(stats.newsWindow.n, 1)
  assert.equal(stats.untaggedCount, 1)
})

test('the thresholds travel with the stats', () => {
  const stats = computeTradeStats(filler(3))

  assert.deepEqual(stats.thresholds, {
    minSample: MIN_SAMPLE,
    earlySignalMax: EARLY_SIGNAL_MAX,
  })
  assert.equal(
    stats.overall.insufficient,
    true,
    'a 3-trade selection is not reportable'
  )
})

test('an empty selection produces a complete, empty stats object', () => {
  const stats = computeTradeStats([])

  assert.equal(stats.overall.n, 0)
  assert.deepEqual(stats.bySetup, {})
  assert.deepEqual(stats.ruleBroken, {})
  assert.equal(stats.untaggedCount, 0)
})

// --- integration with the row mapping -------------------------------------

test('stats are correct on rows mapped from Postgres string numerics', () => {
  const row = (overrides) =>
    fromRow({
      id: 'a1',
      num: 1,
      date: '2026-07-24T15:30',
      pnl: '412.50', // Postgres numerics arrive as strings
      risk: '150',
      rule_broken: ['early_entry'],
      setup_type: 'B',
      away_stack: true,
      entry_delay_sec: 12,
      ...overrides,
    })

  const stats = computeTradeStats([
    row({}),
    row({ id: 'a2', pnl: '-150', risk: '150' }),
  ])

  assert.equal(stats.overall.wins, 1, 'string P&L must not compare as text')
  assert.equal(stats.overall.losses, 1)
  assert.equal(stats.overall.totalR, 1.75)
  assert.equal(stats.overall.avgR, 0.88)
  assert.equal(stats.byEntryDelay['10-30s'].n, 2)
  assert.deepEqual(stats.ruleBroken.early_entry, { count: 2, totalR: 1.75 })
})

test('groupByEach counts a trade in every tag it carries', () => {
  const both = trade({ band_touched: ['+2σ', '-2σ'] })
  const one = trade({ band_touched: ['-2σ'] })

  const groups = groupByEach([both, one], (t) => t.band_touched)

  // Overlapping on purpose: 2 trades, 3 memberships.
  assert.equal(groups['+2σ'].n, 1)
  assert.equal(groups['-2σ'].n, 2)
})

test('groupByEach buckets an empty tag list as untagged', () => {
  const groups = groupByEach([trade({ target: [] })], (t) => t.target)
  assert.equal(groups.untagged.n, 1)
})

test('groupByEach does not iterate a stray scalar character by character', () => {
  const groups = groupByEach([trade({ target: 'VWAP' })], (t) => t.target)
  assert.deepEqual(Object.keys(groups), ['untagged'])
})
