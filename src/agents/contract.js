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
 * @typedef {object} Agent
 * @property {string} id stable key, used for nav state and storage
 * @property {string} title shown in navigation
 * @property {string} [subtitle] one line, shown above the agent's own UI
 * @property {(el: HTMLElement) => void|Promise<void>} mount renders into `el`
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

  return Object.freeze(agent)
}
