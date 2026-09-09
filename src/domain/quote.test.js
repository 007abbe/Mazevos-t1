import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeQuote,
  readCboeQuote,
  readQuote,
  readQuotePayload,
  sessionOpen,
} from './quote.js'

/** 2026-09-09 is a Wednesday. */
const at = (time) => Date.parse(`2026-09-09T${time}-04:00`)

const et = (date, time = '16:00') => Math.floor(Date.parse(`${date}T${time}-04:00`) / 1000)

const payload = ({ stamps, closes, last = 16.34, time = et('2026-09-09', '11:00') }) => ({
  chart: {
    result: [
      {
        meta: { regularMarketPrice: last, regularMarketTime: time },
        timestamp: stamps,
        indicators: { quote: [{ close: closes }] },
      },
    ],
  },
})

test('previous close is the last finished session, not the newest row', () => {
  // During the session the newest row is today, and it is a partial bar. Reading
  // it as a close would report a mid-session print as yesterday's settle.
  const quote = readQuote(
    payload({
      stamps: [et('2026-09-07'), et('2026-09-08'), et('2026-09-09')],
      closes: [15.1, 15.8, 16.2],
    }),
    at('11:00')
  )

  assert.equal(quote.prev, 15.8)
  assert.equal(quote.prev_date, '2026-09-08')
  assert.equal(quote.now, 16.34, 'now comes from the live price, not the bar')
})

test('chartPreviousClose is never used, because it is the wrong close', () => {
  // Yahoo's own field is the close *before the requested range* — six sessions
  // back on a 5d request. It looks plausible and is silently stale.
  const body = payload({
    stamps: [et('2026-09-07'), et('2026-09-08')],
    closes: [15.1, 15.8],
  })
  body.chart.result[0].meta.chartPreviousClose = 14.32

  assert.equal(readQuote(body, at('11:00')).prev, 15.8)
})

test('gaps in the close array are skipped rather than read as zero', () => {
  const quote = readQuote(
    payload({
      stamps: [et('2026-09-04'), et('2026-09-07'), et('2026-09-08')],
      closes: [15.1, null, 15.9],
    }),
    at('11:00')
  )

  assert.equal(quote.prev, 15.9)
})

test('an unrecognised payload yields nulls rather than throwing', () => {
  // A quote that fails must leave the field empty for the trader to fill.
  for (const bad of [null, {}, { chart: {} }, { chart: { result: [] } }]) {
    assert.deepEqual(readQuote(bad, at('11:00')), {
      now: null,
      prev: null,
      prev_date: null,
      as_of: null,
    })
  }
})

test('sessionOpen tracks the 09:30 New York cash open', () => {
  assert.equal(sessionOpen(at('09:29')), false)
  assert.equal(sessionOpen(at('09:30')), true)
  assert.equal(sessionOpen(at('15:00')), true)

  // The weekend has no session whatever the clock says.
  assert.equal(sessionOpen(Date.parse('2026-09-11T11:00:00-04:00')), true, 'Friday is a session')
  assert.equal(sessionOpen(Date.parse('2026-09-12T11:00:00-04:00')), false, 'Saturday is not')
  assert.equal(sessionOpen(Date.parse('2026-09-13T11:00:00-04:00')), false, 'nor Sunday')
})

test('before the open the last price is reported as the previous close', () => {
  // The VIX index is only disseminated during the cash session. Yahoo still
  // returns a price with a fresh timestamp; calling it live would hand the
  // model-risk rules a stale number dressed as today's vol.
  const quote = { now: 15.8, prev: 15.8, prev_date: '2026-09-08' }
  const described = describeQuote(quote, at('08:15'))

  assert.equal(described.live, false)
  assert.match(described.source, /has not opened/)
  assert.equal(described.value, 15.8)
})

test('after the open the live price is used and labelled live', () => {
  const described = describeQuote({ now: 16.34, prev: 15.8 }, at('11:00'))

  assert.equal(described.live, true)
  assert.equal(described.value, 16.34)
  assert.equal(described.prev, 15.8)
})

test('a missing live price falls back to the previous close, and says so', () => {
  const described = describeQuote({ now: null, prev: 15.8 }, at('11:00'))

  assert.equal(described.value, 15.8)
  assert.equal(described.live, false)
  assert.match(described.source, /no live price/)
})

test('nothing at all reports unavailable rather than a fabricated zero', () => {
  const described = describeQuote({ now: null, prev: null }, at('11:00'))

  assert.equal(described.value, null)
  assert.equal(described.source, 'unavailable')
})

test('float artifacts are rounded away before they reach a field', () => {
  // Yahoo returns float32 widened to double: 15.72 arrives as
  // 15.720000267028809, and a number input renders that verbatim. It is the
  // first thing you notice about an auto-filled box, and it reads as broken.
  const quote = readQuote(
    payload({
      stamps: [et('2026-09-07'), et('2026-09-08')],
      closes: [15.100000381469727, 15.720000267028809],
      last: 16.360000610351562,
    }),
    at('11:00')
  )

  assert.equal(quote.prev, 15.72)
  assert.equal(quote.now, 16.36)
})

test('Cboe states the previous close rather than leaving it to be derived', () => {
  const quote = readCboeQuote(
    {
      timestamp: '2026-09-09 16:11:33',
      data: { symbol: '^VIX', current_price: 16.36, prev_day_close: 15.72 },
    },
    at('11:00')
  )

  assert.equal(quote.now, 16.36)
  assert.equal(quote.prev, 15.72)
  assert.equal(quote.prev_date, null, 'named but not dated — not guessed at')
})

test('an unrecognised source reads as nothing rather than half-parsing', () => {
  assert.deepEqual(readQuotePayload({ source: 'somewhere-new', payload: {} }, at('11:00')), {
    now: null,
    prev: null,
    prev_date: null,
    as_of: null,
  })
})

test('readQuotePayload dispatches on the tag the function sent', () => {
  const cboe = readQuotePayload(
    { source: 'cboe', payload: { data: { current_price: 16.36, prev_day_close: 15.72 } } },
    at('11:00')
  )
  assert.equal(cboe.now, 16.36)

  const yahoo = readQuotePayload(
    {
      source: 'yahoo',
      payload: payload({ stamps: [et('2026-09-08')], closes: [15.72] }),
    },
    at('11:00')
  )
  assert.equal(yahoo.prev, 15.72)
})
