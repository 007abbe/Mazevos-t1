import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badge, directionBadge, statusBadge, statusBadgeClass, directionBadgeClass } from './trade-badges.js'

test('each status maps to its own pill class', () => {
  assert.equal(statusBadgeClass('TP'), 'badge-tp')
  assert.equal(statusBadgeClass('SL'), 'badge-sl')
  assert.equal(statusBadgeClass('BE'), 'badge-be')
  assert.equal(statusBadgeClass('TP1+BE'), 'badge-mixed')
  assert.equal(statusBadgeClass('Open'), 'badge-open')
})

test('an unrecognised status falls back to the neutral pill', () => {
  assert.equal(statusBadgeClass('Scratch'), 'badge-be')
  assert.equal(statusBadgeClass(undefined), 'badge-be')
})

test('direction maps Long to green and Short to red', () => {
  assert.equal(directionBadgeClass('Long'), 'badge-long')
  assert.equal(directionBadgeClass('Short'), 'badge-short')
})

test('an unknown direction is neutral rather than silently Short', () => {
  assert.equal(directionBadgeClass('Flat'), 'badge-be')
  assert.equal(directionBadgeClass(null), 'badge-be')
})

test('a badge renders as a span carrying both classes', () => {
  assert.equal(statusBadge('TP'), '<span class="badge badge-tp">TP</span>')
  assert.equal(directionBadge('Short'), '<span class="badge badge-short">Short</span>')
})

test('missing values render an em dash, not an empty pill', () => {
  for (const empty of [null, undefined, '']) {
    assert.equal(badge(empty, 'badge-tp'), '—')
    assert.equal(statusBadge(empty), '—')
    assert.equal(directionBadge(empty), '—')
  }
})

test('labels are escaped', () => {
  assert.equal(
    badge('<img src=x onerror=alert(1)>', 'badge-be'),
    '<span class="badge badge-be">&lt;img src=x onerror=alert(1)&gt;</span>'
  )
})

test('zero is a label, not a missing value', () => {
  assert.equal(badge(0, 'badge-be'), '<span class="badge badge-be">0</span>')
})
