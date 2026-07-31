/**
 * File System Access layer for the Obsidian vault.
 *
 * Chrome and Edge only — Firefox and Safari have no `showDirectoryPicker`.
 *
 * Everything here is read-only. Nothing in this module writes to the vault;
 * the write path lives behind the sync confirm gate and is not wired yet.
 */

/** Folders Gnosis indexes, relative to the vault root. */
export const GNOSIS_DIRS = ['06-Gnosis', '05-Research']

/** Its presence is how we recognise a vault root rather than some other folder. */
const ROOT_MARKER = GNOSIS_DIRS[0]

const DB_NAME = 'gnosis'
const STORE = 'kv'
const HANDLE_KEY = 'vaultHandle'

export const isSupported = () => typeof window !== 'undefined' && !!window.showDirectoryPicker

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function idbSet(key, value) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The stored handle, or null. Does not prompt. */
export async function storedVault() {
  try {
    return (await idbGet(HANDLE_KEY)) ?? null
  } catch {
    return null
  }
}

/**
 * Connection state for display. Never prompts — a permission request needs a
 * user gesture, so it belongs on the button, not on render.
 */
export async function vaultStatus() {
  if (!isSupported()) return { state: 'unsupported', name: null }

  const handle = await storedVault()
  if (!handle) return { state: 'disconnected', name: null }

  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    return {
      state: permission === 'granted' ? 'connected' : 'needs-permission',
      name: handle.name ?? 'vault',
    }
  } catch {
    return { state: 'disconnected', name: null }
  }
}

/**
 * Prompts for the vault root and stores the handle.
 *
 * Asks for `readwrite` up front even though this round only reads: the
 * permission prompt needs a user gesture, and re-prompting later at the moment
 * of the first write is a worse place to be refused.
 */
export async function connectVault() {
  if (!isSupported()) throw new Error('Needs Chrome or Edge — this browser has no directory picker.')

  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })

  let hasMarker = false
  for await (const [name] of handle.entries()) {
    if (name === ROOT_MARKER) hasMarker = true
  }
  if (!hasMarker) {
    throw new Error(`That folder has no ${ROOT_MARKER}/ — pick the vault root itself.`)
  }

  await idbSet(HANDLE_KEY, handle)
  return { name: handle.name }
}

/** The stored handle with permission confirmed. Throws if either is missing. */
export async function ensureAccess() {
  const handle = await storedVault()
  if (!handle) throw new Error('Connect the vault first.')

  let permission = await handle.queryPermission({ mode: 'readwrite' })
  if (permission !== 'granted') {
    permission = await handle.requestPermission({ mode: 'readwrite' })
  }
  if (permission !== 'granted') throw new Error('Vault access denied.')

  return handle
}

async function walk(dirHandle, prefix, out) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue // .obsidian, .trash, .git
    if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`, out)
    else if (/\.(md|txt)$/i.test(name)) out.push({ path: `${prefix}${name}`, handle })
  }
}

/**
 * Every indexable file under the configured folders, with its text read.
 *
 * A missing folder is skipped rather than fatal — a vault may legitimately
 * have only one of them.
 *
 * @returns {Promise<{files: Array<{path: string, text: string, handle: object}>, skippedDirs: string[]}>}
 */
export async function readVaultFiles(handle, { dirs = GNOSIS_DIRS, onProgress = () => {} } = {}) {
  const entries = []
  const skippedDirs = []

  for (const dir of dirs) {
    try {
      const dirHandle = await handle.getDirectoryHandle(dir)
      await walk(dirHandle, `${dir}/`, entries)
    } catch {
      skippedDirs.push(dir)
    }
  }

  const files = []
  for (const [i, entry] of entries.entries()) {
    onProgress(`Reading ${i + 1}/${entries.length}…`)
    const file = await entry.handle.getFile()
    files.push({ path: entry.path, text: await file.text(), handle: entry.handle })
  }

  return { files, skippedDirs }
}

/** Filenames already present in `06-Gnosis/DOM-Reports/`, for the export diff. */
export async function existingReportFilenames(handle) {
  const names = new Set()
  try {
    const gnosisDir = await handle.getDirectoryHandle(GNOSIS_DIRS[0])
    const reportDir = await gnosisDir.getDirectoryHandle('DOM-Reports')
    for await (const [name] of reportDir.entries()) names.add(name)
  } catch {
    // No DOM-Reports folder yet — everything would be new.
  }
  return names
}
