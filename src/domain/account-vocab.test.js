import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_TYPES, ACCOUNT_NAME_MAX, isAccountType, validateAccount,
  BACKTEST_ACCOUNT_TYPE, isBacktestAccount, backtestAccountIds,
} from './account-vocab.js'

const valid = { name: 'Eval1', type: 'Evaluation' }

test('the five types are the vocabulary', () => {
  assert.deepEqual([...ACCOUNT_TYPES].sort(), [
    'Backtest', 'Demo', 'Evaluation', 'Funded', 'Live',
  ])
  assert.ok(isAccountType('Funded'))
  assert.ok(!isAccountType('funded'))
})

test('Backtest is a type, not a flag — an account cannot be Live and backtest', () => {
  assert.ok(isAccountType(BACKTEST_ACCOUNT_TYPE))
  assert.ok(isBacktestAccount({ type: 'Backtest' }))
  assert.ok(!isBacktestAccount({ type: 'Live' }))
  // Unassigned trades pass null here and must not fall into the backtest side.
  assert.ok(!isBacktestAccount(null))
  assert.ok(!isBacktestAccount(undefined))
})

test('backtestAccountIds picks out only the backtest accounts', () => {
  const ids = backtestAccountIds([
    { id: 'a', type: 'Live' },
    { id: 'b', type: 'Backtest' },
    { id: 'c', type: 'Backtest' },
  ])
  assert.deepEqual([...ids].sort(), ['b', 'c'])
  assert.equal(backtestAccountIds().size, 0)
})

test('a named, typed account is valid', () => {
  assert.equal(validateAccount(valid), null)
})

test('a name is required, and whitespace is not a name', () => {
  assert.ok(validateAccount({ ...valid, name: '' }))
  assert.ok(validateAccount({ ...valid, name: '   ' }))
  assert.ok(validateAccount({ ...valid, name: null }))
})

test('the type has to be one of the four', () => {
  assert.ok(validateAccount({ ...valid, type: 'Paper' }))
  assert.ok(validateAccount({ ...valid, type: undefined }))
})

test('names are bounded, measured after trimming', () => {
  assert.equal(validateAccount({ ...valid, name: 'x'.repeat(ACCOUNT_NAME_MAX) }), null)
  assert.ok(validateAccount({ ...valid, name: 'x'.repeat(ACCOUNT_NAME_MAX + 1) }))
  assert.equal(validateAccount({ ...valid, name: `  ${'x'.repeat(ACCOUNT_NAME_MAX)}  ` }), null)
})

test('duplicate names are rejected regardless of case or padding', () => {
  assert.ok(validateAccount(valid, ['Eval1']))
  assert.ok(validateAccount(valid, ['eval1']))
  assert.ok(validateAccount({ ...valid, name: ' Eval1 ' }, ['EVAL1']))
  assert.equal(validateAccount(valid, ['Eval2', 'Live1']), null)
})

test('no existing names means nothing to collide with', () => {
  assert.equal(validateAccount(valid), null)
  assert.equal(validateAccount(valid, []), null)
})
