import './style.css'
import { getRememberedEmail, onAuthChange, signIn, signOut } from './lib/auth.js'
import { renderJournal } from './journal/index.js'

const app = document.querySelector('#app')

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
      <section id="journal"></section>
    </div>
  `
  app.querySelector('#signout').addEventListener('click', () => signOut())
  renderJournal(app.querySelector('#journal'))
}

renderLoading()
onAuthChange((user) => (user ? renderSignedIn(user) : renderSignedOut()))
