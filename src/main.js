import './style.css'
import { getRememberedEmail, onAuthChange, signIn, signOut } from './lib/auth.js'
import { renderJournal } from './journal/index.js'
import { finski } from './agents/finski/index.js'

const app = document.querySelector('#app')

/**
 * The journal plus every agent, as one list of views. Agents are mounted
 * through the same contract, so adding DOM or Gnosis is one import and one
 * array entry.
 */
const VIEWS = [
  { id: 'journal', title: 'Journal', mount: renderJournal },
  finski,
]

function renderLoading() {
  app.innerHTML = `<div class="card"><p class="muted">Checking session…</p></div>`
}

function renderSignedOut(errorMessage = '') {
  const email = getRememberedEmail()
  app.innerHTML = `
    <div class="card">
      <h1>Mazevo</h1>
      <p class="muted">Claudeus Capital HQ</p>
      <form id="login">
        <input id="email" type="email" placeholder="you@email.com" value="${email}" required>
        <input id="password" type="password" placeholder="password" required>
        <button type="submit">Enter the office</button>
      </form>
      <p class="err">${errorMessage}</p>
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
    <div class="card wide">
      <header class="bar">
        <div>
          <h1>Mazevo</h1>
          <p class="muted">${user.email}</p>
        </div>
        <button id="signout" class="ghost">Sign out</button>
      </header>
      <nav class="tabs">
        ${VIEWS.map(
          (v) => `<button type="button" class="tab" data-view="${v.id}">${v.title}</button>`
        ).join('')}
      </nav>
      <p class="muted" id="view-subtitle"></p>
      <section id="view"></section>
    </div>
  `

  app.querySelector('#signout').addEventListener('click', () => signOut())

  const target = app.querySelector('#view')
  const subtitle = app.querySelector('#view-subtitle')

  const show = (id) => {
    const view = VIEWS.find((v) => v.id === id) ?? VIEWS[0]

    app.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('on', tab.dataset.view === view.id)
    })
    subtitle.textContent = view.subtitle ?? ''
    target.innerHTML = ''
    view.mount(target)
  }

  app.querySelector('.tabs').addEventListener('click', (event) => {
    const id = event.target.closest('.tab')?.dataset.view
    if (id) show(id)
  })

  show(VIEWS[0].id)
}

renderLoading()
onAuthChange((user) => (user ? renderSignedIn(user) : renderSignedOut()))
