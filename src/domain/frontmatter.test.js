import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFrontmatter,
  frontmatterWarnings,
  parseFrontmatter,
} from './frontmatter.js'

const TIER = { tier: 2, tier_by: 'gnosis' }

const note = (...lines) => lines.join('\n')

// --- parseFrontmatter -----------------------------------------------------

test('reads flat key/value pairs and separates the body', () => {
  const { hasFrontmatter, data, body } = parseFrontmatter(
    note('---', 'tier: 1', 'topic: gex', '---', '', '# Heading', 'Body text.')
  )

  assert.equal(hasFrontmatter, true)
  assert.deepEqual(data, { tier: '1', topic: 'gex' })
  assert.equal(body, '\n# Heading\nBody text.')
})

test('a note with no frontmatter is all body', () => {
  const { hasFrontmatter, data, body } = parseFrontmatter('# Just a note\n\nText.')

  assert.equal(hasFrontmatter, false)
  assert.deepEqual(data, {})
  assert.equal(body, '# Just a note\n\nText.')
})

test('frontmatter is only recognised at the very start of the file', () => {
  const { hasFrontmatter } = parseFrontmatter('Intro line\n---\ntier: 1\n---\n')
  assert.equal(hasFrontmatter, false)
})

test('quotes are stripped from values but colons inside them survive', () => {
  const { data } = parseFrontmatter(
    note('---', 'source: "CBOE: VIX white paper"', "topic: 'vol-surface'", '---', '')
  )

  assert.equal(data.source, 'CBOE: VIX white paper')
  assert.equal(data.topic, 'vol-surface')
})

test('list items are values, not keys', () => {
  const { data, keys } = parseFrontmatter(
    note('---', 'tags:', '  - vix', '  - gex', '---', '')
  )

  assert.deepEqual(Object.keys(data), ['tags'])
  assert.ok(!keys.has('- vix'))
})

test('an indented key counts as seen but not as top-level', () => {
  const { data, keys } = parseFrontmatter(
    note('---', 'meta:', '  tier: 1', '---', '')
  )

  assert.ok(!('tier' in data), 'a nested tier is not a top-level declaration')
  assert.ok(keys.has('tier'), 'but it is still seen, so it blocks a write')
})

test('CRLF frontmatter parses the same as LF', () => {
  const { data, body } = parseFrontmatter('---\r\ntier: 3\r\n---\r\nBody')

  assert.deepEqual(data, { tier: '3' })
  assert.equal(body, 'Body')
})

// --- the append-only invariant --------------------------------------------

test('INVARIANT: an existing key is never overwritten', () => {
  const original = note('---', 'tier: 1', 'tier_by: abbe', '---', '', 'Body.')
  const { text, added, skipped } = appendFrontmatter(original, TIER)

  assert.equal(text, original, 'the file is returned byte-identical')
  assert.deepEqual(added, {})
  assert.deepEqual(skipped.sort(), ['tier', 'tier_by'])
})

test('INVARIANT: a nested key of the same name also blocks the write', () => {
  const original = note('---', 'meta:', '  tier: 1', '---', '', 'Body.')
  const { text, added } = appendFrontmatter(original, { tier: 2 })

  assert.equal(text, original, 'in doubt, write nothing')
  assert.deepEqual(added, {})
})

test('INVARIANT: existing frontmatter lines are preserved byte for byte', () => {
  const original = note(
    '---',
    'topic:    gex   ',
    'tags:',
    '  - vix',
    "source: 'CBOE: white paper'",
    'weird line with no colon',
    '---',
    '',
    'Body.'
  )
  const { text } = appendFrontmatter(original, TIER)

  const originalBlock = original.match(/^---\n([\s\S]*?)\n---/)[1]
  assert.ok(
    text.includes(originalBlock),
    'every original frontmatter line survives untouched, spacing included'
  )
})

test('INVARIANT: the body is never modified', () => {
  const body = '\n# Heading\n\nText with --- dashes and : colons.\n'
  const original = `---\ntopic: gex\n---\n${body}`
  const { text } = appendFrontmatter(original, TIER)

  assert.ok(text.endsWith(body), 'the body is carried across verbatim')
})

test('INVARIANT: only the missing key is added when one already exists', () => {
  const original = note('---', 'tier: 1', '---', '', 'Body.')
  const { text, added, skipped } = appendFrontmatter(original, TIER)

  assert.deepEqual(added, { tier_by: 'gnosis' })
  assert.deepEqual(skipped, ['tier'])
  assert.match(text, /^---\ntier: 1\ntier_by: gnosis\n---\n/)
  assert.equal((text.match(/tier:/g) || []).length, 1, 'no duplicate tier line')
})

test('INVARIANT: an empty patch leaves the file untouched', () => {
  const original = note('---', 'topic: gex', '---', '', 'Body.')

  assert.equal(appendFrontmatter(original, {}).text, original)
  assert.equal(appendFrontmatter(original, undefined).text, original)
})

// --- what it does write ---------------------------------------------------

test('new keys are appended after the existing block, in order', () => {
  const { text, added } = appendFrontmatter(
    note('---', 'topic: gex', '---', '', 'Body.'),
    TIER
  )

  assert.equal(
    text,
    note('---', 'topic: gex', 'tier: 2', 'tier_by: gnosis', '---', '', 'Body.')
  )
  assert.deepEqual(added, { tier: '2', tier_by: 'gnosis' })
})

test('a note without frontmatter gets a new block at the top', () => {
  const { text, added } = appendFrontmatter('# Heading\n\nBody.', TIER)

  assert.equal(text, '---\ntier: 2\ntier_by: gnosis\n---\n\n# Heading\n\nBody.')
  assert.deepEqual(added, { tier: '2', tier_by: 'gnosis' })
})

test('an empty file gets a block and nothing else', () => {
  assert.equal(appendFrontmatter('', TIER).text, '---\ntier: 2\ntier_by: gnosis\n---\n\n')
})

test('CRLF files stay CRLF — line endings are never mixed', () => {
  const { text } = appendFrontmatter('---\r\ntopic: gex\r\n---\r\nBody', TIER)

  assert.equal(text, '---\r\ntopic: gex\r\ntier: 2\r\ntier_by: gnosis\r\n---\r\nBody')
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF was introduced')
})

test('numeric values are written as plain YAML scalars', () => {
  const { text } = appendFrontmatter('# Note', { tier: 3 })
  assert.match(text, /^---\ntier: 3\n---\n/)
})

test('the returned text and the reported additions always agree', () => {
  // The preview renders `added`; apply writes `text`. If these ever disagreed,
  // the confirm gate would be showing something other than what gets written.
  for (const original of [
    '# No frontmatter',
    note('---', 'topic: gex', '---', 'Body'),
    note('---', 'tier: 1', '---', 'Body'),
    note('---', 'tier: 1', 'tier_by: abbe', '---', 'Body'),
  ]) {
    const { text, added } = appendFrontmatter(original, TIER)

    for (const [key, value] of Object.entries(added)) {
      assert.ok(text.includes(`${key}: ${value}`), `${key} was reported but not written`)
    }
    if (!Object.keys(added).length) assert.equal(text, original)
  }
})

// --- warnings for the preview ---------------------------------------------

test('a clean note raises no warnings', () => {
  assert.deepEqual(
    frontmatterWarnings(note('---', 'topic: gex', 'source: CBOE', '---', 'Body')),
    []
  )
  assert.deepEqual(frontmatterWarnings('# Plain note'), [])
})

test('indented, duplicated and list-valued keys are flagged', () => {
  const warnings = frontmatterWarnings(
    note('---', 'meta:', '  tier: 1', 'topic: a', 'topic: b', 'tags:', '  - vix', '---', 'Body')
  )

  assert.ok(warnings.some((w) => /indented key "tier"/.test(w)))
  assert.ok(warnings.some((w) => /duplicate key "topic"/.test(w)))
  assert.ok(warnings.some((w) => /list values/.test(w)))
})

test('a body opening with a horizontal rule is flagged as probably not frontmatter', () => {
  const warnings = frontmatterWarnings(
    note('---', 'Some prose line', 'another prose line', '---', 'More body')
  )

  assert.ok(warnings.some((w) => /may be body text/.test(w)))
})

test('warnings are deduplicated', () => {
  const warnings = frontmatterWarnings(
    note('---', 'tags:', '  - a', '  - b', '  - c', '---', 'Body')
  )

  assert.equal(warnings.filter((w) => /list values/.test(w)).length, 1)
})
