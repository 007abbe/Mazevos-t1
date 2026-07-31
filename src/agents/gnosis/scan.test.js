import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScanPlan, WRITE_CAP } from './scan.js'
import { MAX_CHARS } from '../../domain/chunking.js'

/** Deterministic stand-in for SHA-256 — the plan only compares hashes. */
const hash = async (text) => `h${text.length}:${text.slice(0, 12)}`

const classifier = (tier = 2) => {
  const calls = []
  const fn = async (path, body) => {
    calls.push({ path, body })
    return { tier, topic: 'guessed-topic', source: 'guessed source' }
  }
  fn.calls = calls
  return fn
}

const file = (path, text) => ({ path, text })
const note = (body = 'Body text long enough to survive the minimum chunk size filter.') => body

const plan = (overrides = {}) =>
  buildScanPlan({
    files: [],
    indexed: new Map(),
    classify: classifier(),
    hash,
    ...overrides,
  })

// --- diffing --------------------------------------------------------------

test('files are classified as new, changed or unchanged against the index', async () => {
  const files = [
    file('06-Gnosis/a.md', 'AAAA'),
    file('06-Gnosis/b.md', 'BBBB'),
    file('06-Gnosis/c.md', 'CCCC'),
  ]
  const indexed = new Map([
    ['06-Gnosis/b.md', await hash('BBBB')], // unchanged
    ['06-Gnosis/c.md', 'stale-hash'], // changed
  ])

  const result = await plan({ files, indexed })
  const status = Object.fromEntries(result.entries.map((e) => [e.path, e.status]))

  assert.deepEqual(status, {
    '06-Gnosis/a.md': 'new',
    '06-Gnosis/b.md': 'unchanged',
    '06-Gnosis/c.md': 'changed',
  })
})

test('unchanged files are never classified', async () => {
  const classify = classifier()
  const files = [file('06-Gnosis/a.md', 'AAAA')]
  const indexed = new Map([['06-Gnosis/a.md', await hash('AAAA')]])

  const result = await plan({ files, indexed, classify })

  assert.equal(result.toTier.length, 0)
  assert.equal(classify.calls.length, 0, 'no tokens spent on untouched notes')
  assert.equal(result.unchanged.length, 1)
})

test('a file already carrying a tier is re-indexed but never tiered', async () => {
  const files = [file('06-Gnosis/a.md', '---\ntier: 1\n---\n\n' + note())]
  const classify = classifier()

  const result = await plan({ files, classify })

  assert.equal(result.toTier.length, 0)
  assert.equal(classify.calls.length, 0)
  assert.equal(result.reindex.length, 1)
})

test('a nested tier also counts as tiered', async () => {
  const files = [file('06-Gnosis/a.md', '---\nmeta:\n  tier: 1\n---\n\n' + note())]

  const result = await plan({ files })

  assert.equal(result.toTier.length, 0, 'in doubt, do not write')
  assert.equal(result.reindex.length, 1)
})

test('index rows whose file is gone are marked for removal', async () => {
  const files = [file('06-Gnosis/a.md', 'AAAA')]
  const indexed = new Map([
    ['06-Gnosis/a.md', 'old'],
    ['06-Gnosis/deleted.md', 'old'],
    ['05-Research/also-gone.md', 'old'],
  ])

  const result = await plan({ files, indexed })

  assert.deepEqual(result.toRemove.sort(), ['05-Research/also-gone.md', '06-Gnosis/deleted.md'])
})

// --- the write cap --------------------------------------------------------

test('the cap bounds how many notes are tiered in one run', async () => {
  const files = Array.from({ length: WRITE_CAP + 12 }, (_, i) =>
    file(`06-Gnosis/n${i}.md`, `${note()} ${i}`)
  )
  const classify = classifier()

  const result = await plan({ files, classify })

  assert.equal(result.toTier.length, WRITE_CAP)
  assert.equal(result.deferred.length, 12)
  assert.equal(classify.calls.length, WRITE_CAP, 'deferred notes cost nothing')
})

test('the cap is configurable, and a small vault stays under it', async () => {
  const files = Array.from({ length: 3 }, (_, i) => file(`06-Gnosis/n${i}.md`, note() + i))

  const capped = await plan({ files, cap: 2 })
  assert.equal(capped.toTier.length, 2)
  assert.equal(capped.deferred.length, 1)

  const uncapped = await plan({ files })
  assert.equal(uncapped.deferred.length, 0)
})

// --- the patch is the preview ---------------------------------------------

test('the plan carries the exact frontmatter lines that would be added', async () => {
  const files = [file('06-Gnosis/a.md', '---\ntopic: gex\n---\n\n' + note())]

  const [entry] = (await plan({ files, classify: classifier(3) })).toTier

  assert.equal(entry.proposedTier, 3)
  assert.deepEqual(entry.patch.added, { tier: '3', tier_by: 'gnosis' })
  assert.match(entry.patch.text, /^---\ntopic: gex\ntier: 3\ntier_by: gnosis\n---\n/)
})

test('topic and source are surfaced as guesses but never patched in', async () => {
  const files = [file('06-Gnosis/a.md', note())]

  const [entry] = (await plan({ files })).toTier

  assert.equal(entry.topicGuess, 'guessed-topic')
  assert.equal(entry.sourceGuess, 'guessed source')
  assert.deepEqual(Object.keys(entry.patch.added).sort(), ['tier', 'tier_by'])
  assert.ok(!entry.patch.text.includes('guessed-topic'), 'the guess stays out of the note')
})

test('the text in the plan is what apply would write, byte for byte', async () => {
  const original = '---\ntopic: gex\n---\n\n' + note()
  const [entry] = (await plan({ files: [file('06-Gnosis/a.md', original)] })).toTier

  // Preview and write are the same string, so the gate cannot show one thing
  // and commit another.
  assert.notEqual(entry.patch.text, original)
  assert.ok(entry.patch.text.endsWith(note()), 'body untouched')
  assert.ok(entry.patch.text.includes('topic: gex'), 'existing frontmatter preserved')
})

test('frontmatter warnings ride along for the preview to mark', async () => {
  const files = [
    file('06-Gnosis/messy.md', '---\ntags:\n  - a\ntopic: x\ntopic: y\n---\n\n' + note()),
    file('06-Gnosis/clean.md', '---\ntopic: gex\n---\n\n' + note()),
  ]

  const result = await plan({ files })
  const byPath = Object.fromEntries(result.entries.map((e) => [e.path, e.warnings]))

  assert.ok(byPath['06-Gnosis/messy.md'].some((w) => /duplicate key "topic"/.test(w)))
  assert.ok(byPath['06-Gnosis/messy.md'].some((w) => /list values/.test(w)))
  assert.deepEqual(byPath['06-Gnosis/clean.md'], [])
})

// --- classification failures ----------------------------------------------

test('a failed classification is reported, not silently defaulted', async () => {
  const failing = async () => {
    throw new Error('rate limited')
  }
  const files = [file('06-Gnosis/a.md', note())]

  const [entry] = (await plan({ files, classify: failing })).toTier

  assert.equal(entry.classifyError, 'rate limited')
  assert.equal(entry.patch, null, 'nothing would be written for this note')
  assert.equal(entry.proposedTier, undefined)
})

test('one failure does not abort the rest of the batch', async () => {
  let n = 0
  const flaky = async () => {
    if (++n === 2) throw new Error('boom')
    return { tier: 2, topic: 't', source: 's' }
  }
  const files = Array.from({ length: 4 }, (_, i) => file(`06-Gnosis/n${i}.md`, note() + i))

  const result = await plan({ files, classify: flaky })

  assert.equal(result.toTier.length, 4)
  assert.equal(result.toTier.filter((e) => e.classifyError).length, 1)
  assert.equal(result.toTier.filter((e) => e.patch).length, 3)
})

// --- chunk reporting ------------------------------------------------------

test('chunk sizes are reported per note and in aggregate', async () => {
  const files = [file('06-Gnosis/a.md', ['x'.repeat(900), 'y'.repeat(900)].join('\n\n'))]

  const result = await plan({ files })
  const [entry] = result.toTier

  assert.ok(entry.chunks.count >= 1)
  assert.equal(entry.chunks.sizes.reduce((a, b) => a + b, 0) > 0, true)
  assert.equal(result.chunks.total, entry.chunks.count)
  assert.equal(result.chunks.largest, entry.chunks.max)
})

test('oversized single-paragraph chunks are surfaced with their path and size', async () => {
  const huge = 'z'.repeat(MAX_CHARS * 2)
  const files = [
    file('06-Gnosis/table.md', huge),
    file('06-Gnosis/normal.md', 'x'.repeat(500)),
  ]

  const result = await plan({ files })

  assert.equal(result.chunks.oversized.length, 1)
  assert.equal(result.chunks.oversized[0].path, '06-Gnosis/table.md')
  assert.equal(result.chunks.oversized[0].size, MAX_CHARS * 2)
  assert.ok(result.chunks.largest > MAX_CHARS)
})

test('oversized chunks are listed largest first', async () => {
  const files = [
    file('06-Gnosis/medium.md', 'a'.repeat(MAX_CHARS + 100)),
    file('06-Gnosis/huge.md', 'b'.repeat(MAX_CHARS * 3)),
  ]

  const result = await plan({ files })

  assert.deepEqual(
    result.chunks.oversized.map((o) => o.path),
    ['06-Gnosis/huge.md', '06-Gnosis/medium.md']
  )
})

test('chunk counts come from the patched text, not the original', async () => {
  // The two added frontmatter lines are stripped before chunking, so they must
  // not leak into the body or inflate the count.
  const files = [file('06-Gnosis/a.md', note())]

  const [entry] = (await plan({ files })).toTier

  assert.ok(!entry.chunks.sizes.some((s) => s === 0))
  assert.ok(!entry.patch.text.includes('tier: 2\n\n'), 'frontmatter stays in the block')
})

// --- report export --------------------------------------------------------

test('only reports without a file are listed for export', async () => {
  const reports = [
    { created_at: '2026-07-30T18:15:00Z', scope: '6 trades', report: 'A' },
    { created_at: '2026-07-29T09:00:00Z', scope: '3 trades', report: 'B' },
  ]
  const existing = new Set([
    // Whichever filename the first report maps to in local time.
    (await import('./export.js')).reportFilename(reports[0].created_at),
  ])

  const result = await plan({ reports, existingReportFiles: existing })

  assert.equal(result.reportsToExport.length, 1)
  assert.equal(result.reportsToExport[0].row.report, 'B')
})

test('with no reports there is nothing to export', async () => {
  assert.deepEqual((await plan({})).reportsToExport, [])
})
