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
 *
 * @typedef {object} Agent
 * @property {string} id stable key, used for nav state and storage
 * @property {string} title shown in navigation
 * @property {string} [subtitle] one line, shown above the agent's own UI
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
