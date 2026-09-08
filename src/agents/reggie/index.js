import { defineAgent } from '../contract.js'
import { fetchCalendar } from '../finski/calendar.js'
import { renderReggie, unmountReggie } from './ui.js'
import { ensureTodaySnapshot } from './mac/auto.js'
import { fetchSeries } from './mac/client.js'
import { priorSnapshot, saveSnapshot, snapshotFor } from './mac/snapshots.js'
import { runMac } from './mac/run.js'

export const reggie = defineAgent({
  id: 'reggie',
  title: 'Reggie',
  subtitle: 'Macro reader · factor states, regime composition, daily snapshot',
  mount: renderReggie,
  unmount: unmountReggie,
})

/**
 * Runs mac once per day, called by the shell on load.
 *
 * The wiring lives here rather than inside `auto.js` because `auto.js` has to
 * stay runnable under `node --test`, and anything that reaches
 * `src/lib/supabase.js` cannot — it reads `import.meta.env` at module load,
 * which only Vite defines. So the schedule logic is pure and testable, and this
 * is the one line that knows about the real I/O.
 */
export const runDailyMac = () =>
  ensureTodaySnapshot({
    read: snapshotFor,
    compute: runMac,
    deps: { fetchSeries, fetchCalendar, priorSnapshot, saveSnapshot },
  })
