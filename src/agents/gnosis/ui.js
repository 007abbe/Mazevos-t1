import { MAX_CHARS } from '../../domain/chunking.js'
import { classifyNote } from './client.js'
import { listIndexedFiles, listReportsForExport } from './index-store.js'
import { buildScanPlan, WRITE_CAP } from './scan.js'
import {
  connectVault,
  ensureAccess,
  existingReportFilenames,
  isSupported,
  readVaultFiles,
  sha256,
  vaultStatus,
} from './vault.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

const STATUS_TEXT = {
  unsupported: 'This browser has no directory picker — use Chrome or Edge.',
  disconnected: 'not connected',
  'needs-permission': (name) => `connected: ${name} — Scan will ask to re-grant access`,
  connected: (name) => `✓ connected: ${name}`,
}

/** The two lines that would be appended, rendered as they'd appear in the file. */
const patchLines = (patch) =>
  Object.entries(patch.added)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')

const warningMarks = (warnings) =>
  warnings.length
    ? `<ul class="scan-warnings">${warnings.map((w) => `<li>⚠ ${esc(w)}</li>`).join('')}</ul>`
    : ''

const tierRow = (entry) => {
  if (entry.classifyError) {
    return `
      <div class="scan-row scan-row-error">
        <div class="scan-path mono">${esc(entry.path)}</div>
        <div class="err">Classification failed: ${esc(entry.classifyError)} — this note would be skipped.</div>
      </div>`
  }

  return `
    <div class="scan-row">
      <div class="scan-head">
        <span class="scan-path mono">${esc(entry.path)}</span>
        <span class="level level-t${esc(entry.proposedTier)}">Tier ${esc(entry.proposedTier)}</span>
        <span class="muted">${esc(entry.status)}</span>
      </div>
      <pre class="scan-patch">${esc(patchLines(entry.patch))}</pre>
      <div class="muted scan-meta">
        would add ${plural(Object.keys(entry.patch.added).length, 'line')} ·
        ${plural(entry.chunks.count, 'chunk')}, largest ${entry.chunks.max} chars
        ${entry.chunks.oversize ? ` · <span class="bad">${entry.chunks.oversize} oversized</span>` : ''}
      </div>
      <div class="muted scan-meta">
        guessed topic <em>${esc(entry.topicGuess ?? '—')}</em>,
        source <em>${esc(entry.sourceGuess ?? '—')}</em>
        — shown only, not written
      </div>
      ${warningMarks(entry.warnings)}
    </div>`
}

const listBlock = (title, items, render) =>
  items.length
    ? `<details class="scan-block"><summary>${esc(title)} (${items.length})</summary>${items.map(render).join('')}</details>`
    : ''

function renderPlan(plan) {
  const failed = plan.toTier.filter((e) => e.classifyError).length
  const writable = plan.toTier.length - failed

  const summary = `
    <div class="scan-summary">
      <div><b>${plan.entries.length}</b> notes scanned</div>
      <div><b>${writable}</b> would be tiered${failed ? ` · <span class="bad">${failed} failed</span>` : ''}</div>
      <div><b>${plan.reindex.length}</b> re-indexed, no write</div>
      <div><b>${plan.unchanged.length}</b> unchanged</div>
      <div><b>${plan.deferred.length}</b> deferred past the cap of ${plan.cap}</div>
      <div><b>${plan.toRemove.length}</b> index rows removed</div>
      <div><b>${plan.reportsToExport.length}</b> DOM reports exported</div>
    </div>`

  const chunks = `
    <div class="scan-summary">
      <div><b>${plan.chunks.total}</b> chunks total</div>
      <div>largest <b>${plan.chunks.largest}</b> chars (limit ${MAX_CHARS})</div>
      <div class="${plan.chunks.oversized.length ? 'bad' : 'ok'}">
        <b>${plan.chunks.oversized.length}</b> over the limit
      </div>
    </div>
    ${
      plan.chunks.oversized.length
        ? `<p class="muted">A chunk is always whole paragraphs, so a table or fenced code block with no
             blank line inside it becomes one oversized chunk. These are the candidates for a hard split.</p>
           <pre class="brief">${esc(
             plan.chunks.oversized
               .slice(0, 25)
               .map((o) => `${String(o.size).padStart(7)}  ${o.path}`)
               .join('\n')
           )}</pre>`
        : '<p class="muted">No oversized chunks — no hard-split decision needed.</p>'
    }`

  return `
    <h3 class="agent-section">Plan</h3>
    ${summary}

    <h3 class="agent-section">Chunk sizes</h3>
    ${chunks}

    <h3 class="agent-section">Would be written</h3>
    ${
      plan.toTier.length
        ? plan.toTier.map(tierRow).join('')
        : '<p class="muted">No notes need a tier — nothing would be written.</p>'
    }

    ${listBlock('Deferred past the cap', plan.deferred, (e) => `<div class="scan-row"><span class="scan-path mono">${esc(e.path)}</span></div>`)}
    ${listBlock('Re-indexed only, never written', plan.reindex, (e) => `<div class="scan-row"><span class="scan-path mono">${esc(e.path)}</span> <span class="muted">${plural(e.chunks.count, 'chunk')}</span></div>`)}
    ${listBlock('Unchanged, skipped', plan.unchanged, (e) => `<div class="scan-row"><span class="scan-path mono">${esc(e.path)}</span></div>`)}
    ${listBlock('Index rows to remove', plan.toRemove, (p) => `<div class="scan-row"><span class="scan-path mono">${esc(p)}</span></div>`)}
    ${listBlock('DOM reports to export', plan.reportsToExport, (r) => `<div class="scan-row"><span class="scan-path mono">${esc(r.filename)}</span> <span class="muted">${esc(r.row.scope ?? '')}</span></div>`)}
  `
}

const template = () => `
  <div class="agent-inputs">
    <div class="pick-actions">
      <button type="button" data-act="connect">Connect vault</button>
      <button type="button" class="ghost" data-act="scan">Scan</button>
      <span class="muted" data-role="vault-status">checking…</span>
    </div>

    <p class="muted">
      Scan reads the vault and plans the changes. It writes nothing — not to your notes,
      not to the index. Up to ${WRITE_CAP} untiered notes are classified per run.
    </p>

    <div class="agent-actions">
      <button type="button" data-act="apply" disabled>Apply — not enabled yet</button>
      <span class="muted">Apply is deliberately inert this round.</span>
    </div>

    <p class="err" data-role="error"></p>
    <pre class="brief" data-role="log" hidden></pre>
  </div>

  <div data-role="plan"></div>
`

/** Renders Gnosis into `el`. Scan only — nothing here writes to the vault. */
export function renderGnosis(el) {
  el.innerHTML = template()

  const $ = (role) => el.querySelector(`[data-role="${role}"]`)
  const scanButton = el.querySelector('[data-act="scan"]')

  const setError = (text) => {
    $('error').textContent = text
  }

  const log = (message) => {
    $('log').hidden = false
    $('log').textContent = message
  }

  async function refreshStatus() {
    const { state, name } = await vaultStatus()
    const label = STATUS_TEXT[state]
    $('vault-status').textContent = typeof label === 'function' ? label(name) : label
    scanButton.disabled = state === 'unsupported' || state === 'disconnected'
  }

  async function connect() {
    setError('')
    try {
      const { name } = await connectVault()
      await refreshStatus()
      log(`Connected: ${name}`)
    } catch (err) {
      // An empty message is the user dismissing the picker — not an error.
      if (err?.name !== 'AbortError') setError(err.message)
    }
  }

  async function scan() {
    setError('')
    $('plan').innerHTML = ''
    scanButton.disabled = true
    scanButton.textContent = 'Scanning…'

    try {
      const handle = await ensureAccess()

      log('Reading vault…')
      const [{ files, skippedDirs }, indexed, reports, existingReportFiles] = [
        await readVaultFiles(handle, { onProgress: log }),
        await listIndexedFiles(),
        await listReportsForExport(),
        await existingReportFilenames(handle),
      ]

      if (skippedDirs.length) log(`Skipped missing folders: ${skippedDirs.join(', ')}`)

      const plan = await buildScanPlan({
        files,
        indexed,
        reports,
        existingReportFiles,
        classify: (path, body) => classifyNote(path, body.slice(0, 2500)),
        hash: sha256,
        onProgress: log,
      })

      log(
        `Scan complete. ${files.length} notes read, ${plan.toTier.length} classified. Nothing was written.`
      )
      $('plan').innerHTML = renderPlan(plan)
    } catch (err) {
      log('')
      setError(err.message)
    } finally {
      scanButton.textContent = 'Scan'
      await refreshStatus()
    }
  }

  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')?.dataset.act
    if (action === 'connect') connect()
    if (action === 'scan') scan()
  })

  if (!isSupported()) setError(STATUS_TEXT.unsupported)
  refreshStatus()
}
