import { test } from 'node:test'
import assert from 'node:assert/strict'

import { INITIAL, carryForward, confirm, confirmOnRelease, memory } from './hysteresis.js'

test('memory normalises anything storage hands back', () => {
  assert.deepEqual(memory(null), { ...INITIAL })
  assert.deepEqual(memory('nonsense'), { ...INITIAL })
  assert.deepEqual(memory({ state: -2, candidate: 0, streak: 4 }), {
    state: -2,
    candidate: 0,
    streak: 4,
    releasedOn: null,
  })
})

test('a candidate below the confirmation count leaves the state alone', () => {
  const result = confirm({ candidate: -1, prior: { state: 0 }, confirmations: 3 })

  assert.equal(result.state, 0)
  assert.equal(result.candidate, -1)
  assert.equal(result.streak, 1)
  assert.equal(result.changed, false)
  assert.equal(result.pending, true)
})

test('reaching the count flips the state and clears the counter', () => {
  let mem = { state: 0 }
  for (let i = 0; i < 2; i += 1) mem = confirm({ candidate: -1, prior: mem, confirmations: 3 })

  assert.equal(mem.state, 0, 'two of three is not enough')

  mem = confirm({ candidate: -1, prior: mem, confirmations: 3 })
  assert.equal(mem.state, -1)
  assert.equal(mem.streak, 0)
  assert.equal(mem.candidate, null)
  assert.equal(mem.changed, true)
})

test('an interrupted run starts over rather than resuming', () => {
  let mem = confirm({ candidate: -1, prior: { state: 0 }, confirmations: 3 })
  mem = confirm({ candidate: -1, prior: mem, confirmations: 3 })
  assert.equal(mem.streak, 2)

  // One day back at the published state wipes the count.
  mem = confirm({ candidate: 0, prior: mem, confirmations: 3 })
  assert.equal(mem.streak, 0)
  assert.equal(mem.candidate, null)

  mem = confirm({ candidate: -1, prior: mem, confirmations: 3 })
  assert.equal(mem.streak, 1, 'the run restarts at one, not at three')
  assert.equal(mem.state, 0)
})

test('a candidate that changes its mind never confirms', () => {
  let mem = { state: 0 }
  for (let i = 0; i < 10; i += 1) {
    mem = confirm({ candidate: i % 2 ? 1 : -1, prior: mem, confirmations: 3 })
  }

  assert.equal(mem.state, 0)
  assert.equal(mem.streak, 1)
})

test('a different candidate does not inherit the pending one’s streak', () => {
  let mem = confirm({ candidate: -1, prior: { state: 0 }, confirmations: 3 })
  mem = confirm({ candidate: -1, prior: mem, confirmations: 3 })

  mem = confirm({ candidate: -2, prior: mem, confirmations: 3 })
  assert.equal(mem.candidate, -2)
  assert.equal(mem.streak, 1)
})

test('one confirmation means immediate', () => {
  const result = confirm({ candidate: 2, prior: { state: 0 }, confirmations: 1 })
  assert.equal(result.state, 2)
  assert.equal(result.changed, true)
})

test('the immediate hatch bypasses the count in one direction only', () => {
  // F7's shape: escalate at once, de-escalate on three sessions.
  const escalate = (candidate, prior) =>
    confirm({ candidate, prior, confirmations: 3, immediate: (next, now) => next > now })

  let mem = escalate(2, { state: 0 })
  assert.equal(mem.state, 2, 'entering is immediate')

  mem = escalate(0, mem)
  assert.equal(mem.state, 2, 'leaving waits')
  mem = escalate(0, mem)
  assert.equal(mem.state, 2)
  mem = escalate(0, mem)
  assert.equal(mem.state, 0, 'and lands on the third session')
})

test('confirmOnRelease holds the state between publications', () => {
  const first = confirmOnRelease({ candidate: -1, prior: null, releaseDate: '2026-08-12' })
  assert.equal(first.state, -1, 'the first read establishes the state')
  assert.equal(first.releasedOn, '2026-08-12')

  // Recomputing every day for a month against the same print changes nothing.
  const held = confirmOnRelease({ candidate: 2, prior: first, releaseDate: '2026-08-12' })
  assert.equal(held.state, -1)
  assert.equal(held.changed, false)

  const next = confirmOnRelease({ candidate: 2, prior: held, releaseDate: '2026-09-11' })
  assert.equal(next.state, 2)
  assert.equal(next.changed, true)
  assert.equal(next.releasedOn, '2026-09-11')
})

test('confirmOnRelease with no release date changes nothing', () => {
  const result = confirmOnRelease({ candidate: 2, prior: { state: -1 }, releaseDate: null })
  assert.equal(result.state, -1)
  assert.equal(result.changed, false)
})

test('carryForward preserves the state and flags itself', () => {
  const result = carryForward({ state: -2, candidate: -1, streak: 2 })

  assert.equal(result.state, -2)
  assert.equal(result.streak, 2, 'a stale day does not reset a pending run')
  assert.equal(result.carried, true)
  assert.equal(result.changed, false)
})
