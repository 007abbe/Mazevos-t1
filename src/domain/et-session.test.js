import { test } from 'node:test'
import assert from 'node:assert/strict'
import { etDate, etOffset, nySessionWindow } from './et-session.js'

/** FlowJournal's approximation, kept here to pin the dates where we diverge. */
const flowJournalOffset = (now) => {
  const month = new Date(now).getUTCMonth() + 1
  return month >= 4 && month <= 10 ? '-04:00' : '-05:00'
}

test('etOffset reports EDT in summer and EST in winter', () => {
  assert.equal(etOffset(new Date('2026-07-29T12:00:00Z')), '-04:00')
  assert.equal(etOffset(new Date('2026-01-15T12:00:00Z')), '-05:00')
})

test('etOffset switches on the second Sunday in March, not on 1 April', () => {
  // DST 2026 runs 8 March – 1 November.
  assert.equal(etOffset(new Date('2026-03-07T12:00:00Z')), '-05:00')
  assert.equal(etOffset(new Date('2026-03-08T12:00:00Z')), '-04:00')
  assert.equal(etOffset(new Date('2026-03-20T12:00:00Z')), '-04:00')
  assert.equal(etOffset(new Date('2026-10-31T12:00:00Z')), '-04:00')
  assert.equal(etOffset(new Date('2026-11-02T12:00:00Z')), '-05:00')
})

test('the March window is exactly where we diverge from FlowJournal', () => {
  const divergent = ['2026-03-09', '2026-03-20', '2026-03-31']
  for (const day of divergent) {
    const at = new Date(`${day}T12:00:00Z`)
    assert.equal(etOffset(at), '-04:00')
    assert.equal(flowJournalOffset(at), '-05:00', `${day} should be a known FlowJournal miss`)
  }

  // Outside that window the two agree, so the rest of the year is unchanged.
  const agreeing = ['2026-01-15', '2026-03-02', '2026-04-15', '2026-07-29', '2026-10-20', '2026-12-01']
  for (const day of agreeing) {
    const at = new Date(`${day}T12:00:00Z`)
    assert.equal(etOffset(at), flowJournalOffset(at), `${day} should match FlowJournal`)
  }
})

test('nySessionWindow spans 09:30–12:00 ET', () => {
  const summer = nySessionWindow(Date.parse('2026-07-29T08:00:00-04:00'))
  assert.equal(new Date(summer.open).toISOString(), '2026-07-29T13:30:00.000Z')
  assert.equal(new Date(summer.noon).toISOString(), '2026-07-29T16:00:00.000Z')

  const winter = nySessionWindow(Date.parse('2026-01-15T08:00:00-05:00'))
  assert.equal(new Date(winter.open).toISOString(), '2026-01-15T14:30:00.000Z')
  assert.equal(new Date(winter.noon).toISOString(), '2026-01-15T17:00:00.000Z')
})

test('nySessionWindow uses the post-switch offset on a spring-forward day', () => {
  // 03:00 ET on 8 March 2026 — after the 02:00 switch.
  const window = nySessionWindow(Date.parse('2026-03-08T03:00:00-04:00'))
  assert.equal(new Date(window.open).toISOString(), '2026-03-08T13:30:00.000Z')

  // 01:00 ET, before the switch: the session still opens at 09:30 EDT, which is
  // the case the naive "offset at `now`" approach gets wrong.
  const beforeSwitch = nySessionWindow(Date.parse('2026-03-08T01:00:00-05:00'))
  assert.equal(new Date(beforeSwitch.open).toISOString(), '2026-03-08T13:30:00.000Z')
})

test('etDate returns the New York calendar date, not the UTC one', () => {
  // 23:00 ET on 28 July is already 29 July in UTC.
  assert.equal(etDate(Date.parse('2026-07-28T23:00:00-04:00')), '2026-07-28')
  assert.equal(etDate(Date.parse('2026-07-29T10:00:00-04:00')), '2026-07-29')
})
