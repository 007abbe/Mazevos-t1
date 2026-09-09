/**
 * Fetching ForexFactory calendar pages.
 *
 * Shared by the Action's rolling harvest (`fetch-ism.mjs`) and the one-off deep
 * backfill (`backfill-ism.mjs`), so there is one place that knows how to talk to
 * ForexFactory and one place to fix when that changes.
 *
 * The page is fetched with `curl`, not Node's `fetch`, and that is not a style
 * choice. ForexFactory answers 403 to Node regardless of the headers it sends —
 * the tell is below the header layer, in the TLS and HTTP/2 handshake — while
 * the identical request from curl gets a 200. Browser-shaped headers on `fetch`
 * were tried first and change nothing.
 *
 * curl ships with GitHub's runners and with Windows since 10, so this costs no
 * dependency. Only the fetch is delegated; parsing stays in Node, in a pure
 * module with tests.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { monthUrl } from '../../src/domain/mac/ff-actuals.js'

const run = promisify(execFile)

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One month's calendar page.
 *
 * A 403 is retried with a growing wait, because bursts do get refused even
 * though a single request is fine. Getting that wrong is quiet and expensive:
 * the first request of a rolling run is the current month, the one that carries
 * a new print, so a run that gives up on the first 403 harvests every month
 * except the one that mattered.
 *
 * @param {string} month `YYYY-MM`
 * @param {number} [attempt]
 * @returns {Promise<string>} the page HTML
 */
export async function fetchMonthPage(month, attempt = 0) {
  if (attempt > 0) await sleep(attempt * 8000)

  try {
    const { stdout } = await run(
      'curl',
      [
        '--silent',
        '--show-error',
        '--fail', // non-2xx becomes a non-zero exit, so it lands in the catch
        '--location',
        '--max-time',
        '30',
        '--user-agent',
        USER_AGENT,
        '--header',
        'accept-language: en-US,en;q=0.9',
        monthUrl(month),
      ],
      // The month pages run to about 1.6 MB, well past execFile's 1 MB default.
      { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }
    )

    return stdout
  } catch (err) {
    if (attempt < 3) return fetchMonthPage(month, attempt + 1)
    throw new Error((err.stderr || err.message).trim().split('\n')[0])
  }
}
