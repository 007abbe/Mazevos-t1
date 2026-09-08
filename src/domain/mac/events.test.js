import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SIZE_CAP,
  classifyDay,
  dateFlags,
  eventsOn,
  horizonOf,
  isAuction,
  monthEnd,
  noTradeWindows,
  opexDate,
  sessionsFrom,
  tierOf,
} from './events.js'

/** A feed row. Times are ET, matching what ForexFactory publishes. */
const event = (title, date, { impact = 'High', country = 'USD', forecast = '', previous = '' } = {}) => ({
  title,
  country,
  impact,
  date,
  forecast,
  previous,
})

/**
 * A Low-impact row, so the feed demonstrably covers a date without contributing
 * any tier. An empty array now means "this feed does not reach today", which is
 * a different thing from "today is quiet".
 */
const covers = (date) => event('Some Speech', `${date}T13:00:00-04:00`, { impact: 'Low' })

const CALM = { size_cap: 1, spm_allowed: true, mm_preferred: false }
const ELEVATED = { size_cap: 0.75, spm_allowed: true, mm_preferred: true }
const HOSTILE = { size_cap: 0.5, spm_allowed: false, mm_preferred: true }

/** 2026-09-08 is a Tuesday. 08:00 ET. */
const TUE = Date.parse('2026-09-08T08:00:00-04:00')

test('tierOf puts curve-repricing releases in tier 1', () => {
  assert.equal(tierOf(event('CPI m/m', '2026-09-08T08:30:00-04:00')), 1)
  assert.equal(tierOf(event('Non-Farm Employment Change', '2026-09-08T08:30:00-04:00')), 1)
  assert.equal(tierOf(event('PPI m/m', '2026-09-08T08:30:00-04:00')), 1)
  assert.equal(tierOf(event('FOMC Statement', '2026-09-08T14:00:00-04:00')), 1)
})

test('tierOf keeps second-tier movers out of tier 1', () => {
  assert.equal(tierOf(event('Core PCE Price Index m/m', '2026-09-08T08:30:00-04:00')), 2)
  assert.equal(tierOf(event('ISM Manufacturing PMI', '2026-09-08T10:00:00-04:00')), 2)
  assert.equal(tierOf(event('Retail Sales m/m', '2026-09-08T08:30:00-04:00')), 2)
})

test('tierOf ignores other currencies and low impact', () => {
  assert.equal(tierOf(event('CPI m/m', '2026-09-08T08:30:00-04:00', { country: 'EUR' })), null)
  assert.equal(tierOf(event('CPI m/m', '2026-09-08T08:30:00-04:00', { impact: 'Low' })), null)
  assert.equal(tierOf(event('Some Speech', '2026-09-08T13:00:00-04:00')), null)
})

test('a medium-impact CPI is not tier 1', () => {
  // Tier 1 is the "stand aside" tier; it needs High impact as well as the title.
  assert.equal(tierOf(event('CPI m/m', '2026-09-08T08:30:00-04:00', { impact: 'Medium' })), null)
})

test('isAuction matches the Treasury supply rows', () => {
  assert.equal(isAuction(event('10-y Bond Auction', '2026-09-08T13:00:00-04:00')), true)
  assert.equal(isAuction(event('30-y Bond Auction', '2026-09-08T13:00:00-04:00')), true)
  assert.equal(isAuction(event('CPI m/m', '2026-09-08T08:30:00-04:00')), false)
})

test('sessionsFrom skips weekends', () => {
  // 2026-09-11 is a Friday.
  assert.deepEqual(sessionsFrom('2026-09-11', 3), ['2026-09-11', '2026-09-14', '2026-09-15'])
  assert.deepEqual(sessionsFrom('2026-09-12', 1), ['2026-09-14'], 'a Saturday start rolls forward')
})

test('opexDate is the third Friday', () => {
  assert.equal(opexDate('2026-09-08'), '2026-09-18')
  assert.equal(opexDate('2026-01-05'), '2026-01-16')
})

test('monthEnd is the last weekday of the month', () => {
  // 2026-05-31 is a Sunday, so May ends on Friday the 29th.
  assert.equal(monthEnd('2026-05-04'), '2026-05-29')
  assert.equal(monthEnd('2026-09-08'), '2026-09-30')
})

test('dateFlags marks opex, month end, quarter end and roll week', () => {
  assert.equal(dateFlags('2026-09-18').opex, true)
  assert.equal(dateFlags('2026-09-30').quarter_end, true)
  assert.equal(dateFlags('2026-09-30').month_end, true)
  assert.equal(dateFlags('2026-08-31').quarter_end, false, 'August is not a quarter month')
  assert.equal(dateFlags('2026-08-31').month_end, true)
  assert.equal(dateFlags('2026-09-15').roll_week, true, 'the week before quarterly expiry')
  assert.equal(dateFlags('2026-09-08').roll_week, false)
})

test('eventsOn selects by New York date, not UTC', () => {
  // 20:00 ET on the 8th is 00:00 UTC on the 9th. Dating this by UTC would file
  // it under the wrong session.
  const calendar = [
    event('CPI m/m', '2026-09-08T20:00:00-04:00'),
    event('Retail Sales m/m', '2026-09-09T08:30:00-04:00'),
  ]

  assert.equal(eventsOn(calendar, '2026-09-08').length, 1)
  assert.equal(eventsOn(calendar, '2026-09-08')[0].title, 'CPI m/m')
})

test('eventsOn drops malformed dates rather than passing an Invalid Date on', () => {
  assert.deepEqual(eventsOn([event('CPI m/m', 'not-a-date')], '2026-09-08'), [])
  assert.deepEqual(eventsOn(null, '2026-09-08'), [])
})

test('a tier 1 release blacks out five minutes', () => {
  const events = eventsOn([event('CPI m/m', '2026-09-08T08:30:00-04:00')], '2026-09-08')
  const windows = noTradeWindows(events, '2026-09-08')

  assert.deepEqual(windows, [{ from: '08:30', to: '08:35', why: 'CPI m/m — release' }])
})

test('the FOMC window is the statement, not the calendar row’s minute', () => {
  const events = eventsOn([event('FOMC Statement', '2026-09-08T13:45:00-04:00')], '2026-09-08')
  const windows = noTradeWindows(events, '2026-09-08')

  assert.deepEqual(windows, [
    { from: '14:00', to: '14:15', why: 'FOMC Statement — statement window' },
  ])
})

test('two tier 1 prints at the same minute make one window', () => {
  const events = eventsOn(
    [event('CPI m/m', '2026-09-08T08:30:00-04:00'), event('Core CPI m/m', '2026-09-08T08:30:00-04:00')],
    '2026-09-08'
  )
  const windows = noTradeWindows(events, '2026-09-08')

  assert.equal(windows.length, 1)
  assert.match(windows[0].why, /CPI m\/m — release; Core CPI m\/m — release/)
})

test('a tier 1 day caps size at 50% and prefers MM when vol is elevated', () => {
  const day = classifyDay({
    calendar: [event('CPI m/m', '2026-09-08T08:30:00-04:00')],
    volRegime: 'elevated',
    volEffect: ELEVATED,
    now: TUE,
  })

  assert.equal(day.day_type, 'tier1_event')
  assert.equal(day.size_cap, SIZE_CAP.tier1)
  assert.equal(day.mm_preferred, true)
  assert.equal(day.spm_allowed, true, '08:30 leaves an hour before the open')
})

test('a tier 1 print inside the session disables SPM', () => {
  const day = classifyDay({
    calendar: [event('FOMC Statement', '2026-09-08T11:00:00-04:00')],
    volRegime: 'calm',
    volEffect: CALM,
    now: TUE,
  })

  assert.equal(day.spm_allowed, false)
})

test('size_cap is the minimum of the vol and event caps, never their product', () => {
  const day = classifyDay({
    calendar: [event('Retail Sales m/m', '2026-09-08T08:30:00-04:00')],
    volRegime: 'hostile',
    volEffect: HOSTILE,
    now: TUE,
  })

  assert.equal(day.size_cap, 0.5, 'not 0.5 × 0.75')
  assert.equal(day.day_type, 'tier2_event')
})

test('day_type falls through tier 1, tier 2, auction, quarter end, normal', () => {
  const at = (calendar, now = TUE) =>
    classifyDay({ calendar, volRegime: 'calm', volEffect: CALM, now }).day_type

  assert.equal(at([event('CPI m/m', '2026-09-08T08:30:00-04:00')]), 'tier1_event')
  assert.equal(at([event('Retail Sales m/m', '2026-09-08T08:30:00-04:00')]), 'tier2_event')
  assert.equal(at([event('10-y Bond Auction', '2026-09-08T13:00:00-04:00')]), 'auction_day')
  assert.equal(at([covers('2026-09-08')]), 'normal')

  // 2026-09-30 is the last weekday of September.
  assert.equal(
    at([covers('2026-09-30')], Date.parse('2026-09-30T08:00:00-04:00')),
    'quarter_end'
  )
})

test('a tier 1 event outranks an auction on the same day', () => {
  const day = classifyDay({
    calendar: [
      event('10-y Bond Auction', '2026-09-08T13:00:00-04:00'),
      event('CPI m/m', '2026-09-08T08:30:00-04:00'),
    ],
    volRegime: 'calm',
    volEffect: CALM,
    now: TUE,
  })

  assert.equal(day.day_type, 'tier1_event')
})

test('a calm normal day caps nothing', () => {
  const day = classifyDay({
    calendar: [covers('2026-09-08')],
    volRegime: 'calm',
    volEffect: CALM,
    now: TUE,
  })

  assert.equal(day.day_type, 'normal')
  assert.equal(day.stale, false)
  assert.equal(day.size_cap, 1)
  assert.equal(day.spm_allowed, true)
  assert.equal(day.mm_preferred, false)
  assert.deepEqual(day.no_trade_windows, [])
})

test('a feed that stops before today refuses to type the day', () => {
  // The real failure: a weekly file nobody refreshed still parses, still holds
  // no events dated today, and would otherwise yield a confident
  // "normal day, cap 100%, SPM allowed" from a file that never heard of today.
  const day = classifyDay({
    calendar: [event('CPI m/m', '2026-08-27T08:30:00-04:00')],
    volRegime: 'calm',
    volEffect: CALM,
    now: TUE,
  })

  assert.equal(day.day_type, null, 'untyped, not "normal"')
  assert.equal(day.stale, true)
  assert.equal(day.feed_ends, '2026-08-27')
  assert.equal(day.horizon_sessions, 0)
  assert.deepEqual(day.events_next_5, [])
})

test('an empty feed is treated exactly like a stale one', () => {
  const day = classifyDay({ calendar: [], volRegime: 'calm', volEffect: CALM, now: TUE })

  assert.equal(day.day_type, null)
  assert.equal(day.stale, true)
  assert.equal(day.feed_ends, null)
})

test('a stale feed still falls back to the vol-only caps', () => {
  const day = classifyDay({
    calendar: [event('CPI m/m', '2026-08-27T08:30:00-04:00')],
    volRegime: 'hostile',
    volEffect: HOSTILE,
    now: TUE,
  })

  assert.equal(day.size_cap, 0.5, 'vol still gates even when the calendar cannot')
  assert.equal(day.spm_allowed, false)
})

test('the horizon reports how far the feed actually reached', () => {
  // A Tuesday read against a feed that ends Friday: two sessions short of five.
  const calendar = [
    event('Retail Sales m/m', '2026-09-09T08:30:00-04:00'),
    event('CPI m/m', '2026-09-11T08:30:00-04:00'),
  ]

  const horizon = horizonOf(calendar, '2026-09-08')

  assert.equal(horizon.sessions, 4, 'Tue through Fri')
  assert.equal(horizon.ends, '2026-09-11')
  assert.equal(horizon.truncated, true)
  assert.equal(horizon.events.length, 2)
})

test('a Monday read against a full week is not truncated', () => {
  const calendar = [event('CPI m/m', '2026-09-11T08:30:00-04:00')]
  const horizon = horizonOf(calendar, '2026-09-07')

  assert.equal(horizon.sessions, 5)
  assert.equal(horizon.truncated, false)
})

test('an empty feed reaches nowhere and says so', () => {
  const horizon = horizonOf([], '2026-09-08')

  assert.equal(horizon.sessions, 0)
  assert.equal(horizon.truncated, true)
  assert.equal(horizon.covers_today, false)
  // Not today. Reporting today as the end date reads as "checked through
  // today", which is the opposite of the truth.
  assert.equal(horizon.ends, null)
  assert.equal(horizon.feed_ends, null)
  assert.deepEqual(horizon.events, [])
})

test('covers_today is false once the feed stops short of today', () => {
  const stale = horizonOf([event('CPI m/m', '2026-08-27T08:30:00-04:00')], '2026-09-08')
  assert.equal(stale.covers_today, false)
  assert.equal(stale.feed_ends, '2026-08-27')

  const fresh = horizonOf([event('CPI m/m', '2026-09-11T08:30:00-04:00')], '2026-09-08')
  assert.equal(fresh.covers_today, true)
})

test('classifyDay surfaces the horizon alongside the day type', () => {
  const day = classifyDay({
    calendar: [event('CPI m/m', '2026-09-11T08:30:00-04:00')],
    volRegime: 'calm',
    volEffect: CALM,
    now: TUE,
  })

  assert.equal(day.day_type, 'normal', 'Friday’s CPI does not type Tuesday')
  assert.equal(day.horizon_truncated, true)
  assert.equal(day.events_next_5.length, 1)
  assert.equal(day.events_next_5[0].tier, 1)
})
