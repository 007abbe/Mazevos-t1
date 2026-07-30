import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_KEY,
  CACHE_TTL_MS,
  fetchCalendar,
  readCache,
  todayUsdEvents,
  writeCache,
} from './calendar.js'

/** 08:00 ET on a summer weekday. */
const NOW = Date.parse('2026-07-29T08:00:00-04:00')

/** Shaped exactly as the ForexFactory weekly feed delivers a row. */
const feedEvent = (overrides = {}) => ({
  title: 'ISM Services PMI',
  country: 'USD',
  date: '2026-07-29T10:00:00-04:00',
  impact: 'High',
  forecast: '52.1',
  previous: '51.6',
  ...overrides,
})

const fakeStorage = (seed = {}) => {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    get size() {
      return store.size
    },
  }
}

/** Resolves a URL to a payload; anything unlisted rejects like a network error. */
const fakeFetch = (routes) => {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const route = routes[url]
    if (!route) throw new Error('network down')
    if (route.status && route.status !== 200) {
      return { ok: false, status: route.status, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => route.body }
  }
  impl.calls = calls
  return impl
}

const URLS = { url: '/data/ff_calendar.json', fallbackUrl: 'https://feed.example/ff.json' }

// --- todayUsdEvents -------------------------------------------------------

test('keeps only USD High/Medium events on the current New York date', () => {
  const events = todayUsdEvents(
    [
      feedEvent({ title: 'keep: high' }),
      feedEvent({ title: 'keep: medium', impact: 'Medium' }),
      feedEvent({ title: 'drop: low impact', impact: 'Low' }),
      feedEvent({ title: 'drop: not USD', country: 'EUR' }),
      feedEvent({ title: 'drop: yesterday', date: '2026-07-28T10:00:00-04:00' }),
      feedEvent({ title: 'drop: tomorrow', date: '2026-07-30T10:00:00-04:00' }),
    ],
    NOW
  )

  assert.deepEqual(
    events.map((e) => e.title),
    ['keep: high', 'keep: medium']
  )
})

test('"today" is the New York date even when UTC has already rolled over', () => {
  // 22:00 ET on the 29th is 02:00 UTC on the 30th.
  const lateEvening = Date.parse('2026-07-29T22:00:00-04:00')
  const events = todayUsdEvents([feedEvent()], lateEvening)

  assert.equal(events.length, 1, 'an event earlier the same ET day still counts')
})

test('events sort chronologically, not in feed order', () => {
  const events = todayUsdEvents(
    [
      feedEvent({ title: 'third', date: '2026-07-29T14:00:00-04:00' }),
      feedEvent({ title: 'first', date: '2026-07-29T08:30:00-04:00' }),
      feedEvent({ title: 'second', date: '2026-07-29T10:00:00-04:00' }),
    ],
    NOW
  )

  assert.deepEqual(
    events.map((e) => e.title),
    ['first', 'second', 'third']
  )
})

test('each event carries ET, CET and the labelled pair', () => {
  const [event] = todayUsdEvents(
    [feedEvent({ date: '2026-07-29T08:30:00-04:00' })],
    NOW
  )

  assert.equal(event.timeET, '08:30')
  assert.equal(event.timeCET, '14:30')
  assert.equal(event.timeLabel, '08:30 ET / 14:30 CET')
  assert.equal(event.dt.toISOString(), '2026-07-29T12:30:00.000Z')
})

test('the CET offset follows the release instant, not a fixed shift', () => {
  // January: ET is EST, Stockholm is CET — still six hours apart, but both
  // sides have moved, so a hardcoded offset would drift.
  const winter = Date.parse('2026-01-15T08:00:00-05:00')
  const [event] = todayUsdEvents(
    [feedEvent({ date: '2026-01-15T08:30:00-05:00' })],
    winter
  )

  assert.equal(event.timeLabel, '08:30 ET / 14:30 CET')
})

test('malformed dates are dropped instead of reaching the rules', () => {
  const events = todayUsdEvents(
    [feedEvent({ title: 'bad', date: 'not a date' }), feedEvent({ title: 'good' })],
    NOW
  )

  assert.deepEqual(
    events.map((e) => e.title),
    ['good']
  )
})

test('a non-array payload yields no events rather than throwing', () => {
  assert.deepEqual(todayUsdEvents(null, NOW), [])
  assert.deepEqual(todayUsdEvents({ error: 'nope' }, NOW), [])
})

// --- cache ----------------------------------------------------------------

test('the cache round-trips and expires after the TTL', () => {
  const storage = fakeStorage()
  const events = [feedEvent()]
  writeCache(storage, events, NOW)

  assert.deepEqual(readCache(storage, NOW), { events, fresh: true })

  const justInside = readCache(storage, NOW + CACHE_TTL_MS - 1)
  assert.equal(justInside.fresh, true)

  const justOutside = readCache(storage, NOW + CACHE_TTL_MS)
  assert.equal(justOutside.fresh, false, 'expired, but still readable as stale')
  assert.deepEqual(justOutside.events, events)
})

test('an absent or corrupt cache entry reads as a miss', () => {
  assert.equal(readCache(fakeStorage(), NOW), null)
  assert.equal(readCache(fakeStorage({ [CACHE_KEY]: '{ broken' }), NOW), null)
  assert.equal(readCache(fakeStorage({ [CACHE_KEY]: '{"ts":1}' }), NOW), null)
  assert.equal(readCache(undefined, NOW), null)
})

test('a storage that refuses writes does not break the fetch path', () => {
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
  assert.doesNotThrow(() => writeCache(throwing, [feedEvent()], NOW))
})

// --- fetchCalendar --------------------------------------------------------

test('a fresh cache is served without touching the network', async () => {
  const events = [feedEvent()]
  const storage = fakeStorage()
  writeCache(storage, events, NOW)
  const fetchImpl = fakeFetch({})

  const result = await fetchCalendar({ fetchImpl, storage, now: NOW, ...URLS })

  assert.deepEqual(result, { events, fromCache: true })
  assert.equal(fetchImpl.calls.length, 0)
})

test('the same-origin file is preferred and its result cached', async () => {
  const events = [feedEvent()]
  const storage = fakeStorage()
  const fetchImpl = fakeFetch({ [URLS.url]: { body: events } })

  const result = await fetchCalendar({ fetchImpl, storage, now: NOW, ...URLS })

  assert.deepEqual(result, { events, fromCache: false })
  assert.deepEqual(fetchImpl.calls, [URLS.url], 'fallback must not be attempted')
  assert.deepEqual(readCache(storage, NOW), { events, fresh: true })
})

test('a stale cache does not prevent a refresh', async () => {
  const stale = [feedEvent({ title: 'old' })]
  const fresh = [feedEvent({ title: 'new' })]
  const storage = fakeStorage()
  writeCache(storage, stale, NOW - CACHE_TTL_MS - 1)
  const fetchImpl = fakeFetch({ [URLS.url]: { body: fresh } })

  const result = await fetchCalendar({ fetchImpl, storage, now: NOW, ...URLS })

  assert.deepEqual(result, { events: fresh, fromCache: false })
})

test('a missing repo file falls through to the direct feed', async () => {
  const events = [feedEvent()]
  const fetchImpl = fakeFetch({
    [URLS.url]: { status: 404 },
    [URLS.fallbackUrl]: { body: events },
  })

  const result = await fetchCalendar({
    fetchImpl,
    storage: fakeStorage(),
    now: NOW,
    ...URLS,
  })

  assert.deepEqual(result, { events, fromCache: false })
  assert.deepEqual(fetchImpl.calls, [URLS.url, URLS.fallbackUrl])
})

test('a non-array response is rejected and falls through', async () => {
  const events = [feedEvent()]
  const fetchImpl = fakeFetch({
    [URLS.url]: { body: { error: 'rate limited' } },
    [URLS.fallbackUrl]: { body: events },
  })

  const result = await fetchCalendar({
    fetchImpl,
    storage: fakeStorage(),
    now: NOW,
    ...URLS,
  })

  assert.deepEqual(result.events, events)
})

test('both sources failing serves an expired cache, flagged stale', async () => {
  const events = [feedEvent()]
  const storage = fakeStorage()
  writeCache(storage, events, NOW - CACHE_TTL_MS - 1)
  const fetchImpl = fakeFetch({})

  const result = await fetchCalendar({ fetchImpl, storage, now: NOW, ...URLS })

  assert.deepEqual(result, { events, fromCache: true, stale: true })
})

test('both sources failing with no cache throws an actionable error', async () => {
  const fetchImpl = fakeFetch({ [URLS.url]: { status: 404 } })

  await assert.rejects(
    fetchCalendar({ fetchImpl, storage: fakeStorage(), now: NOW, ...URLS }),
    (err) => {
      assert.match(err.message, /Calendar unavailable/)
      assert.match(err.message, /HTTP 404/, 'names why the repo file failed')
      assert.match(err.message, /Fetch FF calendar/, 'names the fix')
      assert.match(err.message, /network down/, 'names why the feed failed')
      return true
    }
  )
})
