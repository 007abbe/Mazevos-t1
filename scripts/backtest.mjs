/**
 * Replays mac over history and scores what it said.
 *
 *   node --env-file=.env scripts/backtest.mjs [--from 2012-01-01] [--to 2026-09-09]
 *                                             [--holdout 2022-01-01] [--no-ism]
 *
 * `--no-ism` replays with the ISM history withheld, which is what mac looks like
 * with no ForexFactory dependency at all — ISM is the only thing FF contributes
 * to the directional bar. F1 then votes on GDPNow and claims alone and can no
 * longer reach ±2, since both of its extreme conditions test the PMI. Running
 * both and comparing the spread is how to find out whether FF is load-bearing
 * for direction or merely present.
 *
 * Needs `FRED_API_KEY` in `.env` for the first run only; after that the vintage
 * cache under `backtest/vintages/` answers everything and the key is not read.
 *
 * The rule this script exists to obey: **it does not contain a model.** Every
 * number it reports comes out of `buildSnapshot` — the same function the live
 * daily run calls, with the same factors, the same hysteresis and the same bar
 * arithmetic. If the two ever disagree, the replay is wrong and this file is
 * where the bug is, because there is deliberately nowhere else for one to hide.
 *
 * What it does own is the honesty of the inputs, and that is three rules:
 *
 *   1. Series are reconstructed point-in-time from ALFRED vintages, so no
 *      revision and no unreleased print is visible early.
 *   2. Nothing dated the session itself is visible, because mac runs pre-market.
 *   3. An ISM print enters only from its `release_date`, not from the month it
 *      describes — the scrape records both for exactly this reason.
 *
 * Yesterday's snapshot is threaded into today's, session after session, so the
 * hysteresis counters accumulate the way they do in production. That is what
 * makes this a replay rather than a series of independent evaluations: F5's
 * latching speed override and F7's three-session exit only mean anything if the
 * chain is unbroken.
 *
 * **L2 day typing is not replayed.** It reads the ForexFactory weekly feed,
 * which only ever holds the current week, so there is no historical calendar to
 * replay it against. The day type and size cap are therefore absent here, and
 * this scores the L1 bar only — which is the part that makes the directional
 * claim.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'

import { SERIES } from '../src/domain/mac/factors.js'
import { buildSnapshot } from '../src/domain/mac/snapshot.js'
import { closesByDate, seriesAsOf, sessionDates } from '../src/domain/mac/vintage.js'
import {
  blockFor,
  buildReport,
  effectiveN,
  familywiseRisk,
  signReport,
} from '../src/domain/mac/backtest-report.js'
import { loadStore, seriesIds } from './lib/fred-vintages.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}`)

/** Holding horizons in sessions: a day, a week, a fortnight, a month. */
const HORIZONS = [1, 5, 10, 20]

/**
 * ISM prints already published on `asOf`.
 *
 * Gated on `release_date`, never on `date`. The August print is dated
 * 2026-08-01 and published 2026-09-01; filtering on the former would hand mac a
 * month of growth data it could not have had, on the days either side of a
 * release — which is exactly when F1 changes state.
 */
const ismKnownOn = (entries, asOf) =>
  entries.filter((e) => (e.release_date ?? e.date) < asOf)

async function main() {
  const from = arg('from', '2012-01-01')
  const to = arg('to', new Date().toISOString().slice(0, 10))
  const holdout = arg('holdout', null)
  const withoutIsm = process.argv.includes('--no-ism')

  const key = process.env.FRED_API_KEY
  const ids = seriesIds(SERIES)

  if (!key) {
    console.log(
      'No FRED_API_KEY in the environment — cached series will still load, but ' +
        'any that are missing cannot be fetched.\n' +
        'Add FRED_API_KEY=<key> to .env and run with: node --env-file=.env ' +
        'scripts/backtest.mjs\n'
    )
  }

  console.log(`Loading ${ids.length} series…`)
  const { store, provenance } = await loadStore(ids, key, (m) => console.log(`  ${m}`))

  const singleVintage = Object.entries(provenance)
    .filter(([, revised]) => !revised)
    .map(([id]) => id)

  if (singleVintage.length) {
    console.log(
      `
${singleVintage.length} series have no revision history and are read as ` +
        `first-print with a one-day publication lag:
  ${singleVintage.join(', ')}`
    )
  }

  const ndxRows = store[SERIES.NASDAQ100.id]
  if (!ndxRows?.length) throw new Error('no NDX series — cannot score anything')

  // Coverage, checked before anything is scored.
  //
  // This exists because its absence already cost one entire result. FRED
  // truncates an over-wide vintage request to the most recent few hundred
  // vintage dates and says nothing about it, so three series arrived holding
  // only their last three years. The replay ran, reported confident numbers,
  // and was measuring a mac with F5 blind for eighty per cent of the window.
  //
  // A series that starts late is not always a bug — GDPNow genuinely begins in
  // 2011 — so this reports rather than throws, but it reports loudly and in
  // terms of the replay window rather than the raw row count, which is the
  // number that misled last time.
  const gaps = []
  for (const [id, rows] of Object.entries(store)) {
    const dates = rows.map((r) => r.date).filter(Boolean)
    const firstObs = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null
    const firstKnown = rows
      .map((r) => r.realtime_start)
      .filter(Boolean)
      .reduce((a, b) => (a < b ? a : b), '9999-12-31')

    if (!firstObs || firstKnown > from) gaps.push({ id, firstObs, firstKnown })
  }

  if (gaps.length) {
    console.log(`\n⚠ ${gaps.length} series do not cover the replay from ${from}:`)
    for (const g of gaps) {
      console.log(`   ${g.id.padEnd(14)} observations from ${g.firstObs ?? '—'}, first published ${g.firstKnown}`)
    }
    console.log('   Sessions before those dates run without them — check this is expected.')
  }

  const closes = closesByDate(ndxRows)
  const sessions = sessionDates(ndxRows, from, to)
  console.log(`\n${sessions.length} sessions from ${sessions[0]} to ${sessions.at(-1)}`)

  const ism = withoutIsm
    ? []
    : JSON.parse(await readFile('public/data/ism_pmi.json', 'utf8')).entries ?? []

  console.log(
    withoutIsm
      ? 'ISM withheld (--no-ism): F1 votes on GDPNow and claims only\n'
      : `${ism.length} ISM prints on file, ${ism[0]?.date} → ${ism.at(-1)?.date}\n`
  )

  const scored = []
  let prior = null
  let previousClose = null

  for (const date of sessions) {
    const snapshot = buildSnapshot({
      series: seriesAsOf(store, date),
      prior,
      // No historical calendar exists, so the day stays untyped — see the note
      // at the top. `resolvePmi` therefore takes ISM from the harvest alone.
      calendar: null,
      ismActuals: ismKnownOn(ism, date),
      today: date,
      computedAt: `${date}T08:00:00-04:00`,
    })

    const close = closes.get(date)

    // The session mac was scoring that morning: its own close against the one
    // it could actually see. An off-by-one here is the classic way a backtest
    // reports a strategy that is really just reading tomorrow's paper.
    if (previousClose != null && close != null) {
      const f = snapshot.l1.factors
      scored.push({
        date,
        bull_pct: snapshot.l1.bar.bull_pct,
        label: snapshot.l1.bar.label,
        bias: snapshot.l1.bias_raw,
        conviction: snapshot.l1.conviction,
        vol_regime: snapshot.l2.vol_regime,
        ret: close / previousClose - 1,
        healthy: (snapshot.data_health?.missing ?? []).length === 0,
        // Per-factor states, so the composite null can be taken apart. A factor
        // that was carried is still recorded: yesterday's state is what mac was
        // showing that morning, which is what is being scored.
        f_growth: f.growth.state,
        f_inflation: f.inflation.state,
        f_rates: f.rates.state,
        f_liquidity: f.liquidity.state,
        f_credit: f.credit.state,
        f_dollar: f.dollar.state,
        carried_credit: f.credit.carried === true,
        close,
        prev_close: previousClose,
      })
    }

    if (close != null) previousClose = close
    prior = snapshot
  }

  // Forward returns at several holding horizons.
  //
  // mac's factors move on a weekly-to-monthly cadence, and the claim they
  // support is "longs may be favoured this week", not "the index closes green
  // tomorrow". Scoring only the next session asks a slow model a fast question.
  //
  // A session scored on the morning of D is entered at the close it could see,
  // D-1, and held to the close of the (h-1)th session after D. So h=1 is the
  // single session mac was scoring, and the alignment matches the daily test
  // exactly rather than approximately.
  for (const h of HORIZONS) {
    for (let i = 0; i < scored.length; i += 1) {
      const entry = scored[i].prev_close
      const exitRow = scored[i + h - 1]
      scored[i][`ret_${h}`] =
        entry != null && exitRow?.close != null ? exitRow.close / entry - 1 : null
    }
  }

  // How far the composite moved overnight. This is the "sharply tomorrow if the
  // data changes drastically" case: a bar that jumped is a different claim from
  // a bar sitting where it has sat for three weeks, and averaging them together
  // hides whichever one works.
  for (let i = 0; i < scored.length; i += 1) {
    scored[i].bias_delta = i === 0 ? 0 : scored[i].bias - scored[i - 1].bias
  }

  await mkdir('backtest', { recursive: true })
  const tag = withoutIsm ? 'sessions-no-ism' : 'sessions'
  await writeFile(`backtest/${tag}.json`, JSON.stringify(scored, null, 1))

  render(`ALL SESSIONS${withoutIsm ? ' — NO ISM' : ''}`, buildReport(scored))

  if (process.argv.includes('--factors')) renderFactors(scored, holdout)
  if (process.argv.includes('--horizons')) renderHorizons(scored, holdout)
  if (process.argv.includes('--changes')) renderChanges(scored)

  if (holdout) {
    // Split, not just reported: a threshold tuned until the whole sample looks
    // good is fitted to it. What survives out-of-sample is the only part worth
    // acting on.
    render(`IN-SAMPLE (before ${holdout})`, buildReport(scored.filter((s) => s.date < holdout)))
    render(`OUT-OF-SAMPLE (${holdout} on)`, buildReport(scored.filter((s) => s.date >= holdout)))
  }

  console.log(`\nPer-session rows written to backtest/${tag}.json`)
}

function render(title, report) {
  if (!report.span) {
    console.log(`\n${title}: no scorable sessions`)
    return
  }

  console.log(`\n${'═'.repeat(72)}\n${title}   ${report.span.from} → ${report.span.to}`)
  console.log('─'.repeat(72))
  console.log(
    `Base rate: ${report.base.n} sessions, mean ${pct(report.base.mean_bps)}bps, ` +
      `up ${report.base.hit_rate}% of days`
  )
  console.log('\nWhat mac said that morning → what the index did that session')
  console.log(
    `  ${'bucket'.padEnd(20)} ${'n'.padStart(6)} ${'mean'.padStart(9)} ` +
      `${'median'.padStart(9)} ${'up %'.padStart(7)}   vs base`
  )

  for (const b of report.buckets) {
    const edge = b.mean_bps == null ? null : b.mean_bps - report.base.mean_bps
    console.log(
      `  ${`${b.text} (${b.range})`.padEnd(20)} ${String(b.n).padStart(6)} ` +
        `${`${pct(b.mean_bps)}bps`.padStart(9)} ${`${pct(b.median_bps)}bps`.padStart(9)} ` +
        `${String(b.hit_rate ?? '—').padStart(7)}   ${edge == null ? '—' : `${pct(edge)}bps`}`
    )
  }

  const { steps, ordered } = report.monotonicity
  console.log(`\nMonotonic steps: ${ordered}/${steps} in the direction mac claims`)

  if (report.spread) {
    const s = report.spread
    const excludesZero = s.low_bps > 0 || s.high_bps < 0
    console.log(
      `Bull-minus-bear spread: ${pct(s.point_bps)}bps ` +
        `[${pct(s.low_bps)}, ${pct(s.high_bps)}] 95% CI`
    )
    console.log(
      `  moving-block bootstrap, ${s.block}-session blocks, ${s.iterations} draws — ` +
        `${excludesZero ? 'excludes zero' : 'straddles zero, so this is noise'}`
    )
  } else {
    console.log('Bull-minus-bear spread: not enough in both buckets to say')
  }

  // The vol table carries dispersion because that is what the size cap is a
  // claim about. A regime with an ordinary mean and twice the spread is exactly
  // the thing worth trading smaller, and a column of means alone would call it
  // null.
  console.log('\nBy vol regime — dispersion matters more than mean here')
  console.log(
    `  ${'regime'.padEnd(20)} ${'n'.padStart(6)} ${'mean'.padStart(9)} ` +
      `${'std dev'.padStart(9)} ${'up %'.padStart(7)} ${'worst 5%'.padStart(11)}`
  )
  for (const v of report.by_vol) {
    console.log(
      `  ${v.regime.padEnd(20)} ${String(v.n).padStart(6)} ` +
        `${`${pct(v.mean_bps)}bps`.padStart(9)} ${`${pct(v.sd_bps)}bps`.padStart(9)} ` +
        `${String(v.hit_rate ?? '—').padStart(7)} ${`${pct(v.p05_bps)}bps`.padStart(11)}`
    )
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`)
  process.exit(1)
})

/**
 * Each factor against the index, on its own.
 *
 * Diagnosis, not validation. Six factors searched at once is six chances for
 * noise to clear a 95% bar, so nothing here counts unless the out-of-sample
 * half agrees with the in-sample half in *sign* — and even then it is a
 * hypothesis to watch forward, not a result to reweight the bar around.
 *
 * The composite is included as a row so the parts can be read against the whole:
 * `bias` is the unscaled sum of the six, `bull_pct` is that sum after the
 * conviction and vol multipliers. If bias separates and bull_pct does not, the
 * composition is destroying signal rather than the factors lacking it.
 */
function renderFactors(scored, holdout) {
  const fields = [
    ['f_growth', 'F1 growth'],
    ['f_inflation', 'F2 inflation'],
    ['f_rates', 'F3 rates'],
    ['f_liquidity', 'F4 liquidity'],
    ['f_credit', 'F5 credit'],
    ['f_dollar', 'F6 dollar'],
    ['bias', 'bias_raw (sum)'],
    ['bull_pct_centred', 'bull_pct (scaled)'],
  ]

  // `bull_pct` is centred on 50, so its sign only means anything once shifted.
  const rows = scored.map((s) => ({ ...s, bull_pct_centred: s.bull_pct - 50 }))
  const inSample = holdout ? rows.filter((s) => s.date < holdout) : rows
  const outSample = holdout ? rows.filter((s) => s.date >= holdout) : []

  console.log(`\n${'═'.repeat(78)}`)
  console.log('EACH FACTOR ALONE — positive-state sessions minus negative-state sessions')
  console.log('─'.repeat(78))
  console.log(
    `With ${fields.length - 2} factors searched at once, the chance at least one clears a 95% ` +
      `bar\nby luck alone is ${familywiseRisk(fields.length - 2)}%. A row counts only if in- and ` +
      `out-of-sample agree in sign.`
  )
  console.log(
    `\n  ${'factor'.padEnd(22)} ${'n−/0/+'.padStart(16)} ${'spread'.padStart(9)} ` +
      `${'95% CI'.padStart(20)}  ${'in'.padStart(8)} ${'out'.padStart(8)}  verdict`
  )

  for (const [field, label] of fields) {
    const all = signReport(rows, field)
    const a = signReport(inSample, field).spread
    const b = outSample.length ? signReport(outSample, field).spread : null

    const counts = all.buckets.map((x) => x.n).join('/')
    const ci = all.spread
      ? `[${pct(all.spread.low_bps)}, ${pct(all.spread.high_bps)}]`
      : '—'
    const point = all.spread ? `${pct(all.spread.point_bps)}bps` : '—'

    const excludesZero = all.spread && (all.spread.low_bps > 0 || all.spread.high_bps < 0)
    const agree =
      a && b && Math.sign(a.point_bps) === Math.sign(b.point_bps) && a.point_bps !== 0

    const verdict = !all.spread
      ? 'no data'
      : excludesZero && agree
        ? '★ survives both'
        : excludesZero
          ? 'in-sample only'
          : agree
            ? 'consistent, not significant'
            : 'noise'

    console.log(
      `  ${label.padEnd(22)} ${counts.padStart(16)} ${point.padStart(9)} ${ci.padStart(20)}  ` +
        `${(a ? `${pct(a.point_bps)}` : '—').padStart(8)} ${(b ? `${pct(b.point_bps)}` : '—').padStart(8)}  ${verdict}`
    )
  }
}

/**
 * The bar and each factor, across holding horizons.
 *
 * The daily test asked a slow model a fast question. These columns ask the
 * question mac's factors are actually shaped for: held a week, a fortnight, a
 * month, does the lean sort anything?
 *
 * Two things keep this honest. The bootstrap block scales with the horizon,
 * because overlapping 20-day returns share 19 of their 20 days and a short
 * block would report an interval several times tighter than the evidence
 * supports. And the effective sample — raw sessions divided by the horizon — is
 * printed next to the raw one, because those diverge fast and only the smaller
 * number is real.
 */
function renderHorizons(scored, holdout) {
  const fields = [
    ['bull_pct_centred', 'THE BAR'],
    ['f_growth', 'F1 growth'],
    ['f_inflation', 'F2 inflation'],
    ['f_rates', 'F3 rates'],
    ['f_liquidity', 'F4 liquidity'],
    ['f_credit', 'F5 credit'],
    ['f_dollar', 'F6 dollar'],
  ]

  const rows = scored.map((s) => ({ ...s, bull_pct_centred: s.bull_pct - 50 }))
  const inSample = holdout ? rows.filter((s) => s.date < holdout) : rows
  const outSample = holdout ? rows.filter((s) => s.date >= holdout) : []

  console.log(`\n${'═'.repeat(78)}`)
  console.log('HOLDING HORIZON — positive-lean sessions minus negative-lean sessions')
  console.log('─'.repeat(78))
  console.log(
    `Returns are cumulative over the hold, so a 20-session figure should be ~20x a\n` +
      `daily one before it means anything. ★ = interval excludes zero AND in- and\n` +
      `out-of-sample agree in sign. ${familywiseRisk(fields.length - 1)}% chance one of the ` +
      `six factors clears by luck.`
  )

  for (const h of HORIZONS) {
    const field = `ret_${h}`
    const block = blockFor(h)
    const usable = rows.filter((s) => Number.isFinite(s[field]))

    console.log(
      `\n  ── hold ${h} session${h > 1 ? 's' : ''} ` +
        `· ${usable.length} sessions, ~${effectiveN(usable.length, h)} independent ` +
        `· ${block}-session blocks ${'─'.repeat(Math.max(0, 20 - String(h).length))}`
    )
    console.log(
      `     ${'lean'.padEnd(20)} ${'spread'.padStart(11)} ${'95% CI'.padStart(22)}   ${'in'.padStart(9)} ${'out'.padStart(9)}`
    )

    for (const [key, label] of fields) {
      const all = signReport(rows, key, { ret: field, block })
      const a = signReport(inSample, key, { ret: field, block }).spread
      const b = outSample.length ? signReport(outSample, key, { ret: field, block }).spread : null

      if (!all.spread) {
        console.log(`     ${label.padEnd(20)} ${'—'.padStart(11)}  (never takes both signs)`)
        continue
      }

      const excludesZero = all.spread.low_bps > 0 || all.spread.high_bps < 0
      const agree = a && b && Math.sign(a.point_bps) === Math.sign(b.point_bps)
      const mark = excludesZero && agree ? ' ★' : excludesZero ? ' ·' : ''

      console.log(
        `     ${label.padEnd(20)} ${`${pct(all.spread.point_bps)}bps`.padStart(11)} ` +
          `${`[${pct(all.spread.low_bps)}, ${pct(all.spread.high_bps)}]`.padStart(22)}   ` +
          `${(a ? pct(a.point_bps) : '—').padStart(9)} ${(b ? pct(b.point_bps) : '—').padStart(9)}${mark}`
      )
    }
  }
}

/**
 * The sharp-change case: what happens after the bar actually moves.
 *
 * A composite that jumped overnight because a factor flipped is a different
 * claim from one sitting where it has sat for three weeks, and pooling them
 * averages a possible signal into a much larger pile of days on which nothing
 * happened. This splits them.
 *
 * Sessions are grouped by how far `bias_raw` moved from the previous session,
 * and scored at every horizon. A move of ±2 or more is roughly "a factor
 * changed state, or two moved together".
 */
function renderChanges(scored) {
  const groups = [
    ['big up', (s) => s.bias_delta >= 2],
    ['small up', (s) => s.bias_delta === 1],
    ['unchanged', (s) => s.bias_delta === 0],
    ['small down', (s) => s.bias_delta === -1],
    ['big down', (s) => s.bias_delta <= -2],
  ]

  console.log(`\n${'═'.repeat(78)}`)
  console.log('AFTER THE BAR MOVES — grouped by the overnight change in bias_raw')
  console.log('─'.repeat(78))
  console.log(
    'If mac reads anything sharply, it should be here: the sessions where the macro\n' +
      'picture actually changed, rather than the many more where it did not.'
  )

  console.log(
    `\n  ${'move'.padEnd(12)} ${'n'.padStart(6)}` +
      HORIZONS.map((h) => `${`hold ${h}`.padStart(12)}`).join('')
  )

  for (const [label, test] of groups) {
    const rows = scored.filter(test)
    const cells = HORIZONS.map((h) => {
      const rets = rows.map((s) => s[`ret_${h}`]).filter(Number.isFinite)
      if (!rets.length) return '—'.padStart(12)
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length
      return `${pct(mean * 10000)}bps`.padStart(12)
    })
    console.log(`  ${label.padEnd(12)} ${String(rows.length).padStart(6)}${cells.join('')}`)
  }

  const all = HORIZONS.map((h) => {
    const rets = scored.map((s) => s[`ret_${h}`]).filter(Number.isFinite)
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    return `${pct(mean * 10000)}bps`.padStart(12)
  })
  console.log(`  ${'ALL'.padEnd(12)} ${String(scored.length).padStart(6)}${all.join('')}`)
}
