import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reportFilename, reportNote, reportsToExport } from './export.js'

test('the filename uses local wall clock, not UTC', () => {
  // 21:15 local. FlowJournal used toISOString(), which in a UTC+2 zone would
  // date an evening report to the following day.
  const evening = new Date('2026-07-30T21:15:00')

  assert.equal(reportFilename(evening), 'DOM-2026-07-30-2115.md')
})

test('the filename is zero-padded throughout', () => {
  assert.equal(reportFilename(new Date('2026-01-05T09:07:00')), 'DOM-2026-01-05-0907.md')
})

test('the note heading agrees with the filename date', () => {
  const createdAt = new Date('2026-07-30T23:40:00')
  const note = reportNote({ created_at: createdAt, scope: '6 trades', report: 'BODY' })

  assert.ok(reportFilename(createdAt).includes('2026-07-30'))
  assert.match(note, /# DOM Report — 2026-07-30/)
})

test('the note carries fixed frontmatter and the report body', () => {
  const note = reportNote({
    created_at: new Date('2026-07-30T21:15:00'),
    scope: '6 trades · 2026-07-21 → 2026-07-26',
    report: 'DOM REPORT\nWHAT THE NUMBERS SAY\n…',
  })

  assert.match(note, /^---\ntier: 1\ntier_by: abbe\nsource: "DOM report"\ntopic: dom-report\n---\n/)
  assert.match(note, /Scope: 6 trades · 2026-07-21 → 2026-07-26/)
  assert.match(note, /WHAT THE NUMBERS SAY/)
})

test('a generated note already declares its tier, so it is never re-classified', () => {
  const note = reportNote({ created_at: new Date(), scope: 's', report: 'r' })
  assert.match(note, /\ntier: 1\n/)
})

test('missing scope or report degrade to empty rather than undefined', () => {
  const note = reportNote({ created_at: new Date('2026-07-30T21:15:00') })

  assert.ok(!note.includes('undefined'))
})

test('reports already exported are filtered out', () => {
  const reports = [
    { created_at: new Date('2026-07-30T21:15:00'), report: 'new' },
    { created_at: new Date('2026-07-29T10:00:00'), report: 'already there' },
  ]
  const existing = new Set(['DOM-2026-07-29-1000.md'])

  const pending = reportsToExport(reports, existing)

  assert.equal(pending.length, 1)
  assert.equal(pending[0].row.report, 'new')
  assert.equal(pending[0].filename, 'DOM-2026-07-30-2115.md')
})

test('with an empty vault folder every report is pending', () => {
  const reports = [{ created_at: new Date(), report: 'a' }, { created_at: new Date(), report: 'b' }]
  assert.equal(reportsToExport(reports, new Set()).length, 2)
})
