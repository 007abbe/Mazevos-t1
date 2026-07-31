import { defineAgent } from '../agents/contract.js'
import { startOffice } from './engine.js'

/**
 * Teardown for the currently mounted office, if any.
 *
 * Module-level because the contract's `unmount` takes no arguments — the shell
 * mounts one view at a time, so a single handle is enough.
 */
let teardown = null

export const office = defineAgent({
  id: 'office',
  title: 'Office',
  subtitle: 'Claudeus Capital HQ · click a room to open it',

  async mount(el, { navigate }) {
    el.innerHTML = `<p class="muted">Opening the office…</p>`

    try {
      teardown = await startOffice(el, navigate)
    } catch (err) {
      // A failed load must still leave nothing running.
      teardown = null
      el.innerHTML = `<p class="err">Could not open the office: ${err.message}</p>`
    }
  },

  unmount() {
    teardown?.()
    teardown = null
  },
})
