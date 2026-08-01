/**
 * The agent contract.
 *
 * Every agent under `src/agents/<name>/` exports one of these from its
 * `index.js`. Finski is the first, so this is where the shape gets fixed —
 * DOM and Gnosis have to fit it without a rewrite, which is why it stays small:
 * identity, plus a single `mount` that owns its own element.
 *
 * Agents do not know about navigation, each other, or the shell. The shell
 * hands over an element and gets out of the way.
 *
 * @typedef {object} ViewContext
 * @property {(id: string) => void} navigate switches to another view by id
 * @property {HTMLElement} header an empty slot in the topbar, to the left of the
 *   shell's own controls. A view may fill it with its own actions — the journal
 *   puts "Log trade" there — or ignore it. The shell empties it between views,
 *   so nothing leaks from one to the next.
 *
 * @typedef {object} Agent
 * @property {string} id stable key, used for nav state and storage
 * @property {string} title shown in navigation
 * @property {string} [pageTitle] heading for the topbar; defaults to `title`,
 *   which lets the sidebar stay terse ("Journal") while the page is explicit
 *   ("Trade Journal")
 * @property {string} [subtitle] one line, shown under the page title
 * @property {(el: HTMLElement, ctx: ViewContext) => void|Promise<void>} mount renders into `el`
 * @property {() => void} [unmount] releases anything `mount` acquired
 *
 * `unmount` is optional because most views own nothing beyond their DOM, which
 * the shell discards anyway. A view that starts a timer, an animation loop or
 * an observer must define it — otherwise those keep running against detached
 * elements for the rest of the session.
 */

const REQUIRED = { id: 'string', title: 'string', mount: 'function' }

/**
 * Validates and freezes an agent definition. Called at module load, so a
 * malformed agent fails on import rather than on first click.
 *
 * @param {Agent} agent
 * @returns {Readonly<Agent>}
 */
export function defineAgent(agent) {
  if (!agent || typeof agent !== 'object') {
    throw new TypeError('defineAgent expects an agent object')
  }

  for (const [key, type] of Object.entries(REQUIRED)) {
    if (typeof agent[key] !== type) {
      throw new TypeError(`Agent "${agent.id ?? '?'}" needs a ${type} ${key}`)
    }
  }

  if (!/^[a-z][a-z0-9-]*$/.test(agent.id)) {
    throw new TypeError(`Agent id "${agent.id}" must be lowercase kebab-case`)
  }

  if (agent.unmount !== undefined && typeof agent.unmount !== 'function') {
    throw new TypeError(`Agent "${agent.id}" has a non-function unmount`)
  }

  return Object.freeze(agent)
}
