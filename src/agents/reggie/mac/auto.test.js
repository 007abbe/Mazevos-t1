import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ensureTodaySnapshot, resetAutoRun } from './auto.js'

/** 2026-09-08 08:00 ET. */
const NOW = Date.parse('2026-09-08T08:00:00-04:00')

const deps = (overrides = {}) => {
  const calls = { read: [], compute: [] }
  return {
    calls,
    args: {
      now: NOW,
      read: async (date) => {
        calls.read.push(date)
        return null
      },
      compute: async (input) => {
        calls.compute.push(input)
        return { snapshot: { date: '2026-09-08' } }
      },
      deps: {},
      ...overrides,
    },
  }
}

test('computes when today has no snapshot', async (t) => {
  t.beforeEach?.(resetAutoRun)
  resetAutoRun()

  const { args, calls } = deps()
  const result = await ensureTodaySnapshot(args)

  assert.equal(result.ran, true)
  assert.deepEqual(calls.read, ['2026-09-08'], 'asks for the ET date, not the UTC one')
  assert.equal(calls.compute.length, 1)
})

test('does nothing when today is already computed', async () => {
  resetAutoRun()

  const { args, calls } = deps({ read: async () => ({ date: '2026-09-08' }) })
  const result = await ensureTodaySnapshot(args)

  assert.equal(result.ran, false)
  assert.match(result.reason, /already computed/)
  assert.equal(calls.compute.length, 0, 'never recomputes a day that exists')
})

test('a failed read means not now, never a duplicate compute', async () => {
  resetAutoRun()

  const { args, calls } = deps({
    read: async () => {
      throw new Error('Not signed in')
    },
  })
  const result = await ensureTodaySnapshot(args)

  assert.equal(result.ran, false)
  assert.equal(calls.compute.length, 0)
})

test('a failed compute is swallowed rather than thrown at the journal', async () => {
  resetAutoRun()

  const { args } = deps({
    compute: async () => {
      throw new Error('FRED 400')
    },
  })

  // This runs behind whatever view the user actually opened. It must never
  // surface as an unhandled rejection over their trade list.
  const result = await ensureTodaySnapshot(args)

  assert.equal(result.ran, false)
  assert.match(result.reason, /FRED 400/)
})

test('two callers on one load share a single run', async () => {
  resetAutoRun()

  let started = 0
  const { args } = deps({
    compute: async () => {
      started += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { snapshot: {} }
    },
  })

  const [a, b] = await Promise.all([ensureTodaySnapshot(args), ensureTodaySnapshot(args)])

  assert.equal(started, 1, 'the shell and a mounted Reggie must not both compute')
  assert.equal(a.ran, true)
  assert.deepEqual(a, b)
})

test('the guard clears, so the next load can run again', async () => {
  resetAutoRun()

  const first = deps()
  await ensureTodaySnapshot(first.args)

  const second = deps()
  await ensureTodaySnapshot(second.args)

  assert.equal(second.calls.compute.length, 1)
})
