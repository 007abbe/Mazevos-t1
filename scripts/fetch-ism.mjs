/**
 * Harvests ISM manufacturing actuals into `public/data/ism_pmi.json`.
 *
 * Run by the "Fetch FF calendar" Action, in Node, on GitHub's runners — which
 * is the only reason this works at all. ForexFactory's calendar page sends no
 * CORS headers, so the browser cannot read it; the Action can, exactly as it
 * already does for the weekly JSON feed.
 *
 * All the parsing lives in `src/domain/mac/ff-actuals.js` and is node-tested.
 * This file is the I/O around it: pick months, fetch, merge, write.
 *
 *   node scripts/fetch-ism.mjs [--depth 6] [--today YYYY-MM-DD]
 *
 * Exits 0 even when nothing was harvested. A failed scrape is not a failed
 * build: mac still has the weekly feed's `previous`, and a red Action every day
 * for a site that is working would train the wrong reflex. Genuine trouble
 * shows up instead as the newest entry falling behind the calendar, which the
 * panel surfaces in red.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ismActuals, mergeActuals, monthsToFetch } from '../src/domain/mac/ff-actuals.js'
import { fetchMonthPage, sleep } from './lib/ff-fetch.mjs'
import { etDate } from '../src/domain/et-session.js'

const OUT = 'public/data/ism_pmi.json'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function readExisting() {
  try {
    const parsed = JSON.parse(await readFile(OUT, 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch {
    return [] // No file yet, or an unreadable one: start over and backfill.
  }
}

async function main() {
  const today = arg('today', etDate(Date.now()))
  const depth = Number(arg('depth', '6'))

  const existing = await readExisting()
  const months = monthsToFetch(existing, today, depth)

  const scraped = []
  const problems = []

  for (const [index, month] of months.entries()) {
    if (index > 0) await sleep(5000)

    try {
      const { entries, error } = ismActuals(await fetchMonthPage(month), { month })
      if (error) problems.push(`${month}: ${error}`)
      scraped.push(...entries)
      console.log(`${month}: ${entries.length} print(s)`)
    } catch (err) {
      problems.push(`${month}: ${err.message}`)
      console.log(`${month}: ${err.message}`)
    }
  }

  const merged = mergeActuals(existing, scraped)

  if (problems.length) console.log(`problems: ${problems.join('; ')}`)

  // The file holds nothing that changes on a quiet run — no timestamp, no
  // problem list. It is committed, and committing triggers a Pages deploy, so a
  // timestamp bumped four times a day would be four rebuilds a day announcing
  // that nothing happened.
  //
  // Staleness is still visible, just derived rather than stamped: each entry
  // carries its `release_date`, and a latest entry that is not last month once
  // the month is a few days old means the harvest has stopped working. The
  // panel reads it that way.
  const after = `${JSON.stringify({ source: 'forexfactory-calendar', entries: merged }, null, 2)}\n`
  const before = await readFile(OUT, 'utf8').catch(() => null)

  if (before === after) {
    console.log(`no change — ${merged.length} month(s) on file`)
    return
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, after)
  console.log(`wrote ${merged.length} month(s), latest ${merged.at(-1)?.date ?? 'none'}`)
}

main().catch((err) => {
  // Still exit 0 — see the header. The message goes to the Action log.
  console.log(`ism harvest failed: ${err.message}`)
})
