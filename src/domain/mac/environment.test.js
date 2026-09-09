import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SERIES } from './factors.js'
import {
  ENVIRONMENT_CONFIRMATIONS,
  environment,
  liquidityStance,
  realRateStance,
  STANDING_CODES,
  standingOf,
} from './environment.js'

const TODAY = '2026-09-08'

const daily = (n, value, end = TODAY) => {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(endMs - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
    value,
  }))
}

const weekly = (n, value, end = TODAY) => {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(endMs - (n - 1 - i) * 7 * 86400000).toISOString().slice(0, 10),
    value: typeof value === 'function' ? value(i, n) : value,
  }))
}

/** Arguments in billions; WALCL and WTREGEN go in as FRED's millions. */
const build = ({ real = 2.0, walclBn = () => 7000, tgaBn = () => 700, rrpBn = () => 300 } = {}) => ({
  [SERIES.DFII10.id]: daily(5, real),
  [SERIES.WALCL.id]: weekly(20, (i, n) => walclBn(i, n) * 1000),
  [SERIES.WTREGEN.id]: weekly(20, (i, n) => tgaBn(i, n) * 1000),
  [SERIES.RRPONTSYD.id]: weekly(20, rrpBn),
})

test('the real yield is read as a level, not as a change', () => {
  // The whole point of this module: F3 already reads the 20-day move in this
  // series. What matters to a long-duration asset is where it sits.
  assert.equal(realRateStance(build({ real: 2.1 }), TODAY).stance, 'restrictive')
  assert.equal(realRateStance(build({ real: 1.0 }), TODAY).stance, 'neutral')
  assert.equal(realRateStance(build({ real: -0.8 }), TODAY).stance, 'accommodative')
})

test('a stale real yield reports no stance rather than a stale one', () => {
  const series = { [SERIES.DFII10.id]: daily(5, 2.0, '2026-01-01') }
  const result = realRateStance(series, TODAY)

  assert.equal(result.stance, null)
  assert.equal(result.stale, true)
})

test('liquidity is read over a quarter, in billions', () => {
  // $200bn added over the 13-week window.
  const expanding = build({ walclBn: (i, n) => (i < n - 13 ? 7000 : 7200) })
  const draining = build({ walclBn: (i, n) => (i < n - 13 ? 7000 : 6800) })

  assert.equal(liquidityStance(expanding, TODAY).stance, 'expanding')
  assert.equal(liquidityStance(draining, TODAY).stance, 'draining')
  assert.equal(liquidityStance(build(), TODAY).stance, 'flat')
})

test('liquidity nets the Treasury balance out of the balance sheet', () => {
  // Reserves flat, but Treasury pulls $300bn into the TGA: liquidity drains
  // even though the balance sheet has not moved. This is the case the units bug
  // made unreadable, so it is worth pinning.
  const series = build({ tgaBn: (i, n) => (i < n - 13 ? 700 : 1000) })
  const result = liquidityStance(series, TODAY)

  assert.equal(result.stance, 'draining')
  assert.ok(result.change_bn < -250 && result.change_bn > -350, `got ${result.change_bn}`)
})

test('only the corners are named', () => {
  assert.equal(standingOf('restrictive', 'draining'), 'headwind')
  assert.equal(standingOf('accommodative', 'expanding'), 'tailwind')

  // Everything else is genuinely mixed, and saying so is the honest answer.
  assert.equal(standingOf('restrictive', 'expanding'), 'mixed')
  assert.equal(standingOf('accommodative', 'draining'), 'mixed')
  assert.equal(standingOf('neutral', 'flat'), 'mixed')
  assert.equal(standingOf(null, 'flat'), null)
})

test('the environment is slow to change, by design', () => {
  const headwind = build({ real: 2.1, walclBn: (i, n) => (i < n - 13 ? 7000 : 6800) })

  let memory = null
  for (let i = 0; i < ENVIRONMENT_CONFIRMATIONS - 1; i += 1) {
    memory = environment({ series: headwind, prior: memory, today: TODAY }).memory
  }
  assert.notEqual(memory.state, 'headwind', 'not published before it has held')

  const settled = environment({ series: headwind, prior: memory, today: TODAY })
  assert.equal(settled.standing, 'headwind')
})

test('a missing input holds the last environment rather than publishing mixed', () => {
  // "Mixed" is a finding. Printing it because the real yield failed to fetch
  // would be indistinguishable from the two channels genuinely disagreeing.
  const prior = { state: STANDING_CODES.headwind, candidate: null, streak: 0, published: true }
  const result = environment({ series: {}, prior, today: TODAY })

  assert.equal(result.standing, 'headwind')
  assert.match(result.standing_text, /Headwind/)
})

test('the note names the mechanism and makes no directional claim', () => {
  const headwind = build({ real: 2.1, walclBn: (i, n) => (i < n - 13 ? 7000 : 6800) })

  let memory = null
  for (let i = 0; i < ENVIRONMENT_CONFIRMATIONS; i += 1) {
    memory = environment({ series: headwind, prior: memory, today: TODAY }).memory
  }
  const { note } = environment({ series: headwind, prior: memory, today: TODAY })

  assert.match(note, /restrictive/)
  assert.match(note, /marginal bid/)
  assert.match(note, /not a directional call/)
  // The thing the bar used to say, and the thing the evidence never supported.
  assert.doesNotMatch(note, /tailwind today|may have a tailwind|favou?rs? longs/i)
})

test('stale inputs are named so a held environment is not mistaken for a fresh one', () => {
  const result = environment({ series: {}, prior: null, today: TODAY })

  assert.ok(result.stale.includes(SERIES.DFII10.id))
  assert.ok(result.stale.includes(SERIES.WALCL.id))
  assert.equal(result.standing, null)
  assert.match(result.standing_text, /Not enough data/)
})

test('no standing code collides with the hysteresis idea of "unset"', () => {
  // `memory()` starts state at 0 and `confirm` short-circuits when the
  // candidate already equals the state. A code of 0 therefore means that label
  // can never be published — which cost three and a half years of "not enough
  // data" on inputs that were entirely healthy.
  for (const [label, code] of Object.entries(STANDING_CODES)) {
    assert.notEqual(code, 0, `${label} must not encode as the unset state`)
  }
})

test('an environment that begins mixed still publishes', () => {
  // The regression above, end to end: neutral rates and flat liquidity is the
  // most ordinary starting condition there is.
  const ordinary = build({ real: 1.0 })

  let memory = null
  for (let i = 0; i < ENVIRONMENT_CONFIRMATIONS; i += 1) {
    memory = environment({ series: ordinary, prior: memory, today: TODAY }).memory
  }

  assert.equal(environment({ series: ordinary, prior: memory, today: TODAY }).standing, 'mixed')
})

test('the first reading publishes at once — there is nothing yet to protect', () => {
  // mac runs once a day. Requiring ten confirmations before the *first*
  // description meant a fortnight of "not enough data" on complete, fresh
  // inputs, with the inputs themselves rendered right beside the message.
  const restrictive = build({ real: 2.43, walclBn: (i, n) => (i < n - 13 ? 7000 : 6800) })
  const first = environment({ series: restrictive, prior: null, today: TODAY })

  assert.equal(first.standing, 'headwind')
  assert.equal(first.memory.published, true)
})

test('but a change still has to hold', () => {
  const restrictive = build({ real: 2.43, walclBn: (i, n) => (i < n - 13 ? 7000 : 6800) })
  let memory = environment({ series: restrictive, prior: null, today: TODAY }).memory

  // Liquidity turns; the environment must not follow on the first session.
  const turned = build({ real: 2.43, walclBn: (i, n) => (i < n - 13 ? 7000 : 7200) })
  const next = environment({ series: turned, prior: memory, today: TODAY })

  assert.equal(next.standing, 'headwind', 'still the established description')

  for (let i = 0; i < ENVIRONMENT_CONFIRMATIONS; i += 1) {
    memory = environment({ series: turned, prior: memory, today: TODAY }).memory
  }
  assert.equal(environment({ series: turned, prior: memory, today: TODAY }).standing, 'mixed')
})

test('a settling environment does not claim its inputs are missing', () => {
  // The note is rendered directly above the inputs it describes.
  const complete = build({ real: 1.0 })
  const note = environment({ series: complete, prior: null, today: TODAY }).note

  assert.doesNotMatch(note, /missing/)
})
