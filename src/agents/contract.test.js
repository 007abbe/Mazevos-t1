import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineAgent } from './contract.js'

const valid = { id: 'finski', title: 'Finski', mount: () => {} }

test('a valid agent is returned frozen', () => {
  const agent = defineAgent({ ...valid, subtitle: 'Pre-market brief' })

  assert.equal(agent.id, 'finski')
  assert.ok(Object.isFrozen(agent), 'the shell must not be able to mutate an agent')
})

test('a missing or mistyped required field fails at import time', () => {
  assert.throws(() => defineAgent({ ...valid, id: undefined }), /string id/)
  assert.throws(() => defineAgent({ ...valid, title: 42 }), /string title/)
  assert.throws(() => defineAgent({ ...valid, mount: 'nope' }), /function mount/)
  assert.throws(() => defineAgent(null), TypeError)
})

test('ids are lowercase kebab-case so they are safe as nav and storage keys', () => {
  assert.ok(defineAgent({ ...valid, id: 'dom' }))
  assert.ok(defineAgent({ ...valid, id: 'gnosis-rag' }))

  assert.throws(() => defineAgent({ ...valid, id: 'Finski' }), /kebab-case/)
  assert.throws(() => defineAgent({ ...valid, id: 'finski brief' }), /kebab-case/)
  assert.throws(() => defineAgent({ ...valid, id: '2fast' }), /kebab-case/)
})

test('subtitle is optional', () => {
  assert.equal(defineAgent(valid).subtitle, undefined)
})
