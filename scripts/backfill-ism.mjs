/**
 * One-off deep backfill of ISM manufacturing actuals.
 *
 * The Action's rolling harvest looks back six months, which is all the live app
 * needs. The replay needs every month it will ever score, so this walks a whole
 * range once and merges into the same file — one ISM history, not two.
 *
 *   node scripts/backfill-ism.mjs --from 2010-01 --to 2026-09
 *
 * Resumable by design: it skips months already on file and writes after every
 * page, so an interrupted run loses at most one request and a second run picks
 * up where the first stopped. That matters because a full range is a few
 * hundred requests and the whole thing takes a quarter of an hour.
 *
 * Deliberately slow. ForexFactory refuses bursts, and the failure mode of going
 * too fast is a run that looks like it worked and quietly has holes in it.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { ismActuals, mergeActuals, reportedMonthOfPage } from '../src/domain/mac/ff-actuals.js'
import { fetchMonthPage, sleep } from './lib/ff-fetch.mjs'

const OUT = 'public/data/ism_pmi.json'
const PACE_MS = 4000

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/** Every `YYYY-MM` from `from` to `to`, inclusive. */
function monthRange(from, to) {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  const months = []

  for (let i = 0; ; i += 1) {
    const d = new Date(Date.UTC(fy, fm - 1 + i, 1))
    const month = d.toISOString().slice(0, 7)
    months.push(month)
    if (d.getUTCFullYear() === ty && d.getUTCMonth() === tm - 1) break
    if (i > 1000) break // A reversed range should stop, not spin.
  }

  return months
}

async function readExisting() {
  try {
    const parsed = JSON.parse(await readFile(OUT, 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

async function write(entries) {
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(
    OUT,
    `${JSON.stringify({ source: 'forexfactory-calendar', entries }, null, 2)}\n`
  )
}

async function main() {
  const from = arg('from', '2010-01')
  const to = arg('to', '2026-09')

  let entries = await readExisting()
  const months = monthRange(from, to)

  let fetched = 0
  let skipped = 0
  const problems = []

  for (const month of months) {
    // A page for month M carries the print for M-1, so what is already on file
    // is what decides whether the page is worth asking for.
    const reports = reportedMonthOfPage(month)
    if (entries.some((entry) => entry.date === reports)) {
      skipped += 1
      continue
    }

    if (fetched > 0) await sleep(PACE_MS)

    try {
      const { entries: found, error } = ismActuals(await fetchMonthPage(month), { month })
      if (error) problems.push(`${month}: ${error}`)

      if (found.length) {
        entries = mergeActuals(entries, found)
        await write(entries) // After every page: an interrupted run keeps its work.
      }

      fetched += 1
      console.log(`${month} → ${found.map((e) => `${e.date.slice(0, 7)} ${e.value}`).join(', ') || 'nothing'}`)
    } catch (err) {
      problems.push(`${month}: ${err.message}`)
      console.log(`${month} → ${err.message}`)
    }
  }

  console.log(
    `\n${entries.length} month(s) on file · ${fetched} fetched · ${skipped} already had`
  )
  if (entries.length) console.log(`range ${entries[0].date} → ${entries.at(-1).date}`)
  if (problems.length) console.log(`problems (${problems.length}): ${problems.slice(0, 10).join('; ')}`)
}

main()
