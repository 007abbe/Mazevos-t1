import { test } from 'node:test'
import assert from 'node:assert/strict'
import { esc, explainFailure } from './ui-text.js'

test('esc neutralises the characters that break out of a template', () => {
  assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  assert.equal(esc('a & b'), 'a &amp; b')
})

test('esc escapes ampersands without double-escaping the result', () => {
  assert.equal(esc('&lt;'), '&amp;lt;')
})

test('esc renders null and undefined as empty, not as the words', () => {
  assert.equal(esc(null), '')
  assert.equal(esc(undefined), '')
  assert.equal(esc(0), '0')
})

test('esc leaves ordinary text alone, including non-ASCII', () => {
  assert.equal(esc('kände mig stressad · -2σ'), 'kände mig stressad · -2σ')
})

test('a session failure gets the specific fix, whatever phrasing it arrives in', () => {
  const expected = 'Session expired — sign out and back in, then retry.'

  for (const message of [
    'Sign in required.',
    'JWT expired',
    'HTTP 401',
    'unauthorized',
    'Not signed in',
  ]) {
    assert.equal(explainFailure(new Error(message), { prefix: 'x' }), expected, message)
  }
})

test('an already-actionable message passes through unchanged', () => {
  const message = 'Calendar unavailable. Repo file: HTTP 404 — run the "Fetch FF calendar" Action.'

  assert.equal(
    explainFailure(new Error(message), {
      prefix: 'Brief failed',
      passThrough: [/Calendar unavailable/i],
    }),
    message
  )
})

test('anything else is prefixed by the caller', () => {
  assert.equal(
    explainFailure(new Error('insert failed'), { prefix: 'Analysis failed' }),
    'Analysis failed: insert failed'
  )
})

test('a session failure outranks a pass-through pattern', () => {
  assert.match(
    explainFailure(new Error('401 while fetching Calendar unavailable'), {
      prefix: 'x',
      passThrough: [/Calendar unavailable/i],
    }),
    /Session expired/
  )
})

test('non-Error values are handled rather than throwing', () => {
  assert.equal(explainFailure('plain string', { prefix: 'Failed' }), 'Failed: plain string')
  assert.equal(explainFailure(null, { prefix: 'Failed' }), 'Failed: null')
  assert.equal(explainFailure(new Error('boom')), 'Failed: boom')
})
