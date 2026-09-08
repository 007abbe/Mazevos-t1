import { esc } from '../../lib/ui-text.js'
import { renderMac } from './mac/ui.js'
import { renderValidation } from './validation/ui.js'

/**
 * Reggie's shell.
 *
 * Reggie is a container for several independent readers, of which mac is the
 * first. They are separate *options* rather than separate agents because they
 * answer the same question from different angles and share one card — and
 * because a trader looking for the macro read should not have to remember which
 * sidebar entry it lives under.
 *
 * Each option owns its element and is mounted lazily. The switcher tears the
 * previous one down before mounting the next, so an option that starts a timer
 * or an observer can define `unmount` and have it honoured — the same contract
 * the shell gives agents, one level down.
 */
const OPTIONS = [
  {
    id: 'mac',
    title: 'mac',
    blurb: 'Systematic macro reader — factor states, regime composition, daily snapshot',
    mount: renderMac,
  },
  {
    id: 'validation',
    title: 'Validation',
    blurb: 'Phase 4 — does the regime separate anything? Expect “not enough data” for months',
    mount: renderValidation,
  },
]

/** Remembers the last option across mounts, per the agent contract's storage note. */
const STORAGE_KEY = 'reggie_option'

const readStored = () => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    // Private mode and blocked site data both throw here. Falling back to the
    // default option is correct; failing to render Reggie is not.
    return null
  }
}

const writeStored = (id) => {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* not remembering the tab is not worth an error path */
  }
}

const template = () => `
  <div class="reggie-options" role="tablist">
    ${OPTIONS.map(
      (option) => `
        <button type="button" class="reggie-option" role="tab"
                data-option="${esc(option.id)}" aria-selected="false">
          ${esc(option.title)}
        </button>
      `
    ).join('')}
  </div>
  <p class="reggie-blurb muted" data-role="blurb"></p>
  <div class="reggie-panel" data-role="panel"></div>
`

/** Renders Reggie into `el`. Returns nothing; the agent's `unmount` is wired below. */
export function renderReggie(el) {
  el.innerHTML = template()

  const panel = el.querySelector('[data-role="panel"]')
  const blurb = el.querySelector('[data-role="blurb"]')

  let current = null

  const show = (id) => {
    const option = OPTIONS.find((o) => o.id === id) ?? OPTIONS[0]

    current?.unmount?.()
    current = option

    el.querySelectorAll('.reggie-option').forEach((button) => {
      const active = button.dataset.option === option.id
      button.classList.toggle('active', active)
      button.setAttribute('aria-selected', String(active))
    })

    blurb.textContent = option.blurb
    panel.innerHTML = ''
    option.mount(panel)
    writeStored(option.id)
  }

  el.querySelector('.reggie-options').addEventListener('click', (event) => {
    const id = event.target.closest('.reggie-option')?.dataset.option
    if (id) show(id)
  })

  show(readStored() ?? OPTIONS[0].id)

  activeOption = () => current
}

/**
 * The mounted option, so the agent's `unmount` can reach it. Module-level
 * because `defineAgent` freezes a plain object and the shell calls `unmount`
 * with no reference to the element it mounted into.
 */
let activeOption = () => null

export function unmountReggie() {
  activeOption()?.unmount?.()
  activeOption = () => null
}
