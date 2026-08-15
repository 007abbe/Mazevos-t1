import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountTypeClass, accountTypeBadge, accountName } from './account-badges.js'

test('each type maps to its own class', () => {
  const classes = ['Live', 'Funded', 'Evaluation', 'Demo'].map(accountTypeClass)
  assert.deepEqual(classes, ['acct-live', 'acct-funded', 'acct-eval', 'acct-demo'])
  assert.equal(new Set(classes).size, 4)
})

test('an unknown type falls back to neutral rather than losing its colour', () => {
  assert.equal(accountTypeClass('Paper'), 'acct-demo')
  assert.equal(accountTypeClass(null), 'acct-demo')
})

test('the name carries the same class as the type', () => {
  const account = { name: 'Eval1', type: 'Evaluation' }
  assert.match(accountName(account), /acct-eval/)
  assert.match(accountTypeBadge(account.type), /acct-eval/)
})

test('no account renders an em dash, not an uncoloured name', () => {
  assert.equal(accountName(null), '<span class="acct-none">—</span>')
  assert.equal(accountName(undefined), '<span class="acct-none">—</span>')
})

test('account names are escaped', () => {
  const html = accountName({ name: '<script>x</script>', type: 'Live' })
  assert.ok(!html.includes('<script>'))
  assert.match(html, /&lt;script&gt;/)
})
