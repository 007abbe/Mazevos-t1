import './style.css'
import { getRememberedEmail, onAuthChange, signIn, signOut } from './lib/auth.js'
import { onSummary } from './lib/summary.js'
import { fmtMoney } from './journal/stats.js'
import { esc } from './lib/ui-text.js'
import { renderJournal } from './journal/index.js'
import { SCOPES } from './journal/filters.js'
import { statistics } from './statistics/index.js'
import { dom } from './agents/dom/index.js'
import { finski } from './agents/finski/index.js'
import { gnosis } from './agents/gnosis/index.js'
import { office } from './office/index.js'

const app = document.querySelector('#app')

/** Releases the mounted shell's subscriptions; set by `renderSignedIn`. */
let teardownShell = null

/**
 * The journal plus every agent, as one list of views. Agents are mounted
 * through the same contract, so adding DOM or Gnosis is one import and one
 * array entry.
 */
const VIEWS = [
  {
    id: 'journal',
    title: 'Journal',
    pageTitle: 'Trade Journal',
    // A getter, not a value: the subtitle is today's date, and the module is
    // evaluated once but the shell can outlive midnight.
    get subtitle() {
      return new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    },
    mount: (el, ctx) => renderJournal(el, { ...ctx, scope: SCOPES.LIVE }),
  },
  {
    // The same view over Backtest accounts. It is a separate nav entry rather
    // than a toggle inside the journal because the numbers must never be
    // glanced at as if they were live — and because the two need their own
    // remembered filters, which a toggle would share.
    id: 'backtest',
    title: 'Backtest',
    pageTitle: 'Backtest',
    subtitle: 'Simulated entries · kept out of every live statistic',
    mount: (el, ctx) => renderJournal(el, { ...ctx, scope: SCOPES.BACKTEST }),
  },
  statistics,
  dom,
  gnosis,
  finski,
  office,
]

/**
 * Nav icons, keyed by view id. They live in the shell rather than on each view
 * because they are navigation chrome — an agent has no business knowing how it
 * is drawn in a list. Stroked 24×24 paths, inheriting currentColor.
 */
const ICONS = {
  journal: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  // A clock turned back: the journal, replayed over history you did not trade.
  backtest: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/>',
  statistics: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  dom: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  gnosis: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  finski: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  office: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
}

const icon = (id) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] ?? ''}</svg>`

function renderLoading() {
  app.innerHTML = `<div class="auth-shell"><div class="card"><p class="muted">Checking session…</p></div></div>`
}

function renderSignedOut(errorMessage = '') {
  const email = getRememberedEmail()
  app.innerHTML = `
    <div class="auth-shell">
      <div class="card">
        <h1>Mazevo</h1>
        <p class="muted">Claudeus Capital HQ</p>
        <form id="login">
          <input id="email" type="email" placeholder="you@email.com" value="${esc(email)}" required>
          <input id="password" type="password" placeholder="password" required>
          <button type="submit">Enter the office</button>
        </form>
        <p class="err">${esc(errorMessage)}</p>
      </div>
    </div>
  `
  const form = app.querySelector('#login')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    form.querySelector('button').disabled = true
    try {
      await signIn(app.querySelector('#email').value.trim(), app.querySelector('#password').value)
      // A SIGNED_IN event re-renders the page.
    } catch (err) {
      renderSignedOut(err.message || 'Login failed')
    }
  })
}

function renderSignedIn(user) {
  app.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="logo">
          <div class="logo-text">Mazevo</div>
          <div class="logo-sub">orderflow · options</div>
        </div>
        <nav class="nav">
          <div class="nav-section">Menu</div>
          ${VIEWS.map(
            (v) => `<button type="button" class="nav-item" data-view="${v.id}">
                      ${icon(v.id)}${esc(v.title)}
                    </button>`
          ).join('')}
        </nav>
        <div class="sidebar-footer">
          <div class="stats-mini">
            <div class="stats-mini-row">
              <span class="stats-mini-label">Total trades</span>
              <span class="stats-mini-val" id="sb-total">—</span>
            </div>
            <div class="stats-mini-row">
              <span class="stats-mini-label">Win rate</span>
              <span class="stats-mini-val" id="sb-wr">—</span>
            </div>
            <div class="stats-mini-row">
              <span class="stats-mini-label">Net P&amp;L</span>
              <span class="stats-mini-val" id="sb-pnl">—</span>
            </div>
          </div>
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div>
            <h1 class="page-title" id="page-title"></h1>
            <p class="page-sub" id="view-subtitle"></p>
          </div>
          <div class="topbar-right">
            <span class="sync-badge" id="sync" title="${esc(user.email)}">
              <span class="sync-dot"></span><span id="sync-label">Synced</span>
            </span>
            <div id="view-actions"></div>
            <button type="button" class="icon-btn" id="signout" title="Sign out" aria-label="Sign out">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
          </div>
        </header>
        <div class="content" id="view"></div>
      </main>
    </div>
  `

  app.querySelector('#signout').addEventListener('click', () => signOut())

  const target = app.querySelector('#view')
  const header = app.querySelector('#view-actions')
  const pageTitle = app.querySelector('#page-title')
  const subtitle = app.querySelector('#view-subtitle')

  const stopSummary = bindSidebarStats(app)
  const stopSync = bindSyncBadge(app)

  /** The view currently mounted, so it can be torn down before the next one. */
  let current = null

  const show = (id) => {
    const view = VIEWS.find((v) => v.id === id) ?? VIEWS[0]

    // Clearing innerHTML detaches the DOM but does not stop anything a view
    // started — timers, animation loops, observers. Ask it to clean up first.
    current?.unmount?.()
    current = view

    app.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.view === view.id)
    })
    pageTitle.textContent = view.pageTitle ?? view.title
    subtitle.textContent = view.subtitle ?? ''
    header.innerHTML = ''
    target.innerHTML = ''
    view.mount(target, { navigate: show, header })
  }

  app.querySelector('.nav').addEventListener('click', (event) => {
    const id = event.target.closest('.nav-item')?.dataset.view
    if (id) show(id)
  })

  // Re-rendering the shell replaces this whole tree. Hand the caller a way to
  // release what it acquired, so subscriptions stop writing into detached nodes
  // instead of piling up one set per render.
  teardownShell = () => {
    current?.unmount?.()
    stopSummary()
    stopSync()
  }

  show(VIEWS[0].id)
}

/** Mirrors whatever the last-loaded view published into the sidebar footer. */
function bindSidebarStats(root) {
  const total = root.querySelector('#sb-total')
  const winRate = root.querySelector('#sb-wr')
  const pnl = root.querySelector('#sb-pnl')

  return onSummary((stats) => {
    total.textContent = stats.count
    winRate.textContent = `${stats.winRate}%`
    pnl.textContent = fmtMoney(stats.netPnl)
    pnl.className = `stats-mini-val ${stats.netPnl >= 0 ? 'ok' : 'bad'}`
  })
}

/**
 * The badge reports connectivity, not a sync queue — this app is cloud-first
 * with no local mirror to reconcile, so there is never anything pending. Offline
 * is the one state worth surfacing: writes will fail until the network is back.
 */
function bindSyncBadge(root) {
  const badge = root.querySelector('#sync')
  const label = root.querySelector('#sync-label')

  const paint = () => {
    const online = navigator.onLine
    badge.classList.toggle('offline', !online)
    label.textContent = online ? 'Synced' : 'Offline'
  }

  window.addEventListener('online', paint)
  window.addEventListener('offline', paint)
  paint()

  return () => {
    window.removeEventListener('online', paint)
    window.removeEventListener('offline', paint)
  }
}

renderLoading()

onAuthChange((user) => {
  teardownShell?.()
  teardownShell = null
  user ? renderSignedIn(user) : renderSignedOut()
})
