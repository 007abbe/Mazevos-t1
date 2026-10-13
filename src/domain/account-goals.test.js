import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountProgress, accountBadgeState, normaliseGoals, validateGoals, hasGoals, PROP_PRESETS,
} from './account-goals.js'

const lucid = PROP_PRESETS.find((p) => p.id === 'lucid-flex-25k')
const t = (date, pnl) => ({ date: `${date}T10:00`, pnl })

test('balance is the starting size plus net P&L', () => {
  const p = accountProgress(lucid, [t('2026-10-01', 200), t('2026-10-02', -50)])
  assert.equal(p.net, 150)
  assert.equal(p.balance, 25150)
  assert.equal(p.tradingDays, 2)
})

test('an EOD floor trails the highest close and stops at the lock', () => {
  // Peak close 25,300 -> floor 24,300. Then the lock (25,100) caps it once the
  // peak passes 26,100.
  let p = accountProgress(lucid, [t('2026-10-01', 300), t('2026-10-02', -100)])
  assert.equal(p.floor, 24300)
  assert.equal(p.buffer, 900)

  p = accountProgress(lucid, [t('2026-10-01', 1500), t('2026-10-02', -300)])
  assert.equal(p.floor, 25100)
  assert.equal(p.floorLocked, true)
})

test('EOD trailing ignores an intraday peak; intraday trailing does not', () => {
  // +400 then -350 on the same day closes at +50.
  const trades = [{ date: '2026-10-01T10:00', pnl: 400 }, { date: '2026-10-01T11:00', pnl: -350 }]
  assert.equal(accountProgress(lucid, trades).floor, 24050)
  assert.equal(accountProgress({ ...lucid, drawdown_type: 'intraday' }, trades).floor, 24400)
})

test('a static floor never moves', () => {
  const p = accountProgress({ ...lucid, drawdown_type: 'static' }, [t('2026-10-01', 900)])
  assert.equal(p.floor, 24000)
})

test('closing at or below the floor is a breach on that day', () => {
  const p = accountProgress(lucid, [t('2026-10-01', 200), t('2026-10-02', -1200)])
  assert.equal(p.state, 'breached')
  assert.equal(p.breachedOn, '2026-10-02')
})

test('a best day over the consistency limit raises the target instead of failing', () => {
  // Best day 1,000 at 50% needs 2,000 total.
  const p = accountProgress(lucid, [t('2026-10-01', 1000), t('2026-10-02', 300)])
  assert.equal(p.consistent, false)
  assert.equal(p.requiredTarget, 2000)
  assert.equal(p.state, 'tracking')
  assert.equal(p.toTarget, 700)
})

test('hitting the target with consistency and enough days is target-hit', () => {
  const p = accountProgress({ ...lucid, min_days: 2 }, [t('2026-10-01', 625), t('2026-10-02', 625)])
  assert.equal(p.state, 'target-hit')
  const short = accountProgress({ ...lucid, min_days: 3 }, [t('2026-10-01', 625), t('2026-10-02', 625)])
  assert.equal(short.state, 'tracking')
  assert.equal(short.daysMet, false)
})

test('daily loss limit hits are listed by day', () => {
  const p = accountProgress({ ...lucid, daily_loss_limit: 300 }, [t('2026-10-01', -300), t('2026-10-02', -100)])
  assert.deepEqual(p.dllHits, ['2026-10-01'])
  assert.equal(p.worstDay, -300)
})

test('an account with no rules still reports P&L and leaves rule fields null', () => {
  const p = accountProgress({}, [t('2026-10-01', 100)])
  assert.equal(p.net, 100)
  assert.equal(p.balance, null)
  assert.equal(p.floor, null)
  assert.equal(p.requiredTarget, null)
  assert.equal(p.state, 'tracking')
})

test('the monthly goal reads this month only', () => {
  const p = accountProgress({ monthly_goal: 1000 }, [t('2026-09-30', 500), t('2026-10-01', 200)], '2026-10')
  assert.equal(p.monthPnl, 200)
})

test('blank form values are null, never 0', () => {
  const g = normaliseGoals({ account_size: '25000', daily_loss_limit: '', status: 'active', firm: '  ' })
  assert.equal(g.account_size, 25000)
  assert.equal(g.daily_loss_limit, null)
  assert.equal(g.status, null)
  assert.equal(g.firm, null)
})

test('validation catches impossible rules', () => {
  assert.equal(validateGoals({ max_drawdown: 1000, drawdown_type: 'eod' }), 'A drawdown needs a starting balance to measure from')
  assert.equal(validateGoals({ consistency_pct: 150 }), 'Consistency is a percent between 1 and 100')
  assert.equal(validateGoals({ profit_target: -5 }), 'Rules cannot be negative')
  assert.equal(validateGoals(lucid), null)
})

test('a hand-set status outranks the computed one', () => {
  assert.equal(accountBadgeState({ status: 'passed' }, { state: 'breached' }), 'passed')
  assert.equal(accountBadgeState({ status: null }, { state: 'breached' }), 'breached')
  assert.equal(hasGoals({}), false)
  assert.equal(hasGoals(lucid), true)
})
