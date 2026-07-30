import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReportPayload,
  generateReport,
  toNotes,
  MAX_ANALYSIS_TRADES,
} from './report.js'

const NOW = new Date('2026-07-30T15:30').getTime()

let seq = 0
const trade = (overrides = {}) => ({
  id: `t${++seq}`,
  num: seq,
  date: '2026-07-30T15:30',
  pnl: 100,
  risk: 50,
  setup_type: 'A',
  band_touched: '-2σ',
  away_stack: true,
  be_reason: null,
  rule_broken: [],
  thesis: 'Bounce off -2σ with away-stack',
  hindsight: 'Held to VWAP',
  ...overrides,
})

// --- toNotes --------------------------------------------------------------

test('notes carry the trader’s own words and the outcome', () => {
  const [note] = toNotes([trade({ num: 7, pnl: 150, risk: 50 })])

  assert.equal(note.num, 7)
  assert.equal(note.outcome, 'WIN')
  assert.equal(note.r, 3)
  assert.equal(note.thesis, 'Bounce off -2σ with away-stack')
  assert.equal(note.hindsight, 'Held to VWAP')
})

test('outcome covers wins, losses and breakeven', () => {
  const notes = toNotes([
    trade({ pnl: 100, date: '2026-07-30T09:00' }),
    trade({ pnl: -50, date: '2026-07-30T10:00' }),
    trade({ pnl: 0, date: '2026-07-30T11:00' }),
  ])

  assert.deepEqual(
    notes.map((n) => n.outcome),
    ['WIN', 'LOSS', 'BE']
  )
})

test('a trade with no declared risk has no R rather than a bogus one', () => {
  const [note] = toNotes([trade({ pnl: 100, risk: 0 })])
  assert.equal(note.r, null)
})

test('notes are chronological, whatever order they were selected in', () => {
  const notes = toNotes([
    trade({ num: 3, date: '2026-07-30T11:00' }),
    trade({ num: 1, date: '2026-07-28T09:00' }),
    trade({ num: 2, date: '2026-07-29T10:00' }),
  ])

  assert.deepEqual(
    notes.map((n) => n.num),
    [1, 2, 3]
  )
})

test('long notes are truncated to keep the payload bounded', () => {
  const [note] = toNotes([
    trade({ thesis: 'x'.repeat(600), hindsight: 'y'.repeat(600) }),
  ])

  assert.equal(note.thesis.length, 400)
  assert.equal(note.hindsight.length, 400)
})

test('missing notes become empty strings, not undefined', () => {
  const [note] = toNotes([trade({ thesis: null, hindsight: undefined })])

  assert.equal(note.thesis, '')
  assert.equal(note.hindsight, '')
})

// --- buildReportPayload ---------------------------------------------------

test('the payload carries stats, notes, scope and a local report date', () => {
  const payload = buildReportPayload({
    trades: [trade({ date: '2026-07-28T09:00' }), trade({ date: '2026-07-30T15:30' })],
    now: NOW,
  })

  assert.equal(payload.stats.overall.n, 2)
  assert.equal(payload.notes.length, 2)
  assert.equal(payload.scope, '2 trades · 2026-07-28 → 2026-07-30')
  assert.equal(payload.reportDate, '2026-07-30')
})

test('the report is dated locally, not in UTC', () => {
  // 23:00 local is already the next day in UTC; the review still belongs to
  // the day the trader is sitting in.
  const lateEvening = new Date('2026-07-30T23:00').getTime()
  const payload = buildReportPayload({ trades: [trade()], now: lateEvening })

  assert.equal(payload.reportDate, '2026-07-30')
})

test('the stats in the payload are the same ones Layer 1 computes', () => {
  const trades = [
    trade({ pnl: 100, risk: 50, setup_type: 'A' }),
    trade({ pnl: -50, risk: 50, setup_type: 'B' }),
  ]
  const { stats } = buildReportPayload({ trades, now: NOW })

  assert.equal(stats.overall.wins, 1)
  assert.equal(stats.overall.losses, 1)
  assert.equal(stats.bySetup.A.n, 1)
  assert.deepEqual(stats.thresholds, { minSample: 5, earlySignalMax: 9 })
  assert.equal(
    stats.overall.insufficient,
    true,
    'the model must be told a 2-trade sample is not reportable'
  )
})

test('an empty selection is refused before a request is built', () => {
  assert.throws(
    () => buildReportPayload({ trades: [], now: NOW }),
    /Select at least one trade/
  )
})

test('an oversized selection is refused rather than silently trimmed', () => {
  const trades = Array.from({ length: MAX_ANALYSIS_TRADES + 1 }, () => trade())

  assert.throws(
    () => buildReportPayload({ trades, now: NOW }),
    /Select at most 200 trades \(201 selected\)/
  )
})

test('a selection at the limit is allowed', () => {
  const trades = Array.from({ length: MAX_ANALYSIS_TRADES }, () => trade())
  const payload = buildReportPayload({ trades, now: NOW })

  assert.equal(payload.notes.length, MAX_ANALYSIS_TRADES)
  assert.equal(payload.stats.overall.n, MAX_ANALYSIS_TRADES)
})

// --- generateReport -------------------------------------------------------

const deps = (overrides = {}) => {
  const saved = []
  const requested = []
  return {
    saved,
    requested,
    deps: {
      requestReport: async (payload) => {
        requested.push(payload)
        return { report: 'DOM REPORT — 2026-07-30\nSAMPLE: 2 trades' }
      },
      saveReport: async (row) => {
        saved.push(row)
      },
      ...overrides,
    },
  }
}

test('generateReport runs stats → prose → save', async () => {
  const { deps: d, saved, requested } = deps()
  const trades = [trade({ id: 'a' }), trade({ id: 'b' })]

  const result = await generateReport({ trades, now: NOW }, d)

  assert.match(result.report, /^DOM REPORT/)
  assert.equal(result.saved, true)
  assert.equal(requested.length, 1)
  assert.equal(requested[0].stats.overall.n, 2)

  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].tradeIds, ['a', 'b'], 'the row records what was analysed')
  assert.equal(saved[0].stats.overall.n, 2, 'the numbers are stored with the prose')
  assert.equal(saved[0].scope, result.scope)
})

test('generateReport reports progress with the trade count', async () => {
  const steps = []
  const { deps: d } = deps()

  await generateReport({ trades: [trade(), trade()], now: NOW }, {
    ...d,
    onProgress: (step) => steps.push(step),
  })

  assert.deepEqual(steps, ['Crunching numbers on 2 trades…'])
})

test('a failed save does not lose the report', async () => {
  const { deps: d } = deps({
    saveReport: async () => {
      throw new Error('insert failed')
    },
  })

  const result = await generateReport({ trades: [trade()], now: NOW }, d)

  assert.equal(result.saved, false)
  assert.equal(result.saveError.message, 'insert failed')
  assert.match(result.report, /DOM REPORT/, 'the analysis is still returned')
})

test('an empty selection never reaches the function', async () => {
  const { deps: d, requested } = deps()

  await assert.rejects(
    generateReport({ trades: [], now: NOW }, d),
    /Select at least one trade/
  )
  assert.equal(requested.length, 0)
})

test('a truncated report is flagged through to the caller', async () => {
  const { deps: d } = deps({
    requestReport: async () => ({ report: 'DOM REPORT — cut', truncated: true }),
  })

  const result = await generateReport({ trades: [trade()], now: NOW }, d)
  assert.equal(result.truncated, true)
})
