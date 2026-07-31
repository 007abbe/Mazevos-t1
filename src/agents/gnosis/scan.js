/**
 * Phase 1 of sync: work out everything that *would* happen, and write nothing.
 *
 * The plan this returns is what the preview renders and what apply will
 * execute. In particular the frontmatter patch is computed here, once, so the
 * text shown in the preview and the text written to disk are the same string.
 *
 * Pure apart from the injected `classify` and `hash` — no vault, no Supabase.
 */

import { appendFrontmatter, frontmatterWarnings, parseFrontmatter } from '../../domain/frontmatter.js'
import { chunkBody, MAX_CHARS } from '../../domain/chunking.js'
import { reportsToExport } from './export.js'

/**
 * Notes tiered per run. The cap exists so a first sync on an untiered vault is
 * a bounded, watchable batch rather than hundreds of writes and LLM calls.
 * Re-running picks up the next batch, since hashes make progress cumulative.
 */
export const WRITE_CAP = 50

/** Concurrent classification requests. */
const CLASSIFY_CONCURRENCY = 4

/** Runs `task` over `items`, `limit` at a time, preserving order. */
async function mapPool(items, limit, task) {
  const results = new Array(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await task(items[i], i)
    }
  })

  await Promise.all(workers)
  return results
}

const chunkStats = (body) => {
  const chunks = chunkBody(body)
  const sizes = chunks.map((c) => c.length)
  return {
    count: chunks.length,
    sizes,
    max: sizes.length ? Math.max(...sizes) : 0,
    oversize: sizes.filter((s) => s > MAX_CHARS).length,
  }
}

/**
 * @param {object} input
 * @param {Array<{path: string, text: string}>} input.files everything on disk
 * @param {Map<string,string>} input.indexed path → hash currently in the index
 * @param {(path: string, body: string) => Promise<{tier: number, topic?: string, source?: string}>} input.classify
 * @param {(text: string) => Promise<string>} input.hash
 * @param {Array<object>} [input.reports] dom_reports rows
 * @param {Set<string>} [input.existingReportFiles] filenames already in the vault
 * @param {number} [input.cap]
 * @param {(message: string) => void} [input.onProgress]
 */
export async function buildScanPlan({
  files,
  indexed,
  classify,
  hash,
  reports = [],
  existingReportFiles = new Set(),
  cap = WRITE_CAP,
  onProgress = () => {},
}) {
  onProgress('Hashing…')

  const entries = []
  for (const file of files) {
    const fileHash = await hash(file.text)
    const known = indexed.get(file.path)
    const { keys } = parseFrontmatter(file.text)

    entries.push({
      path: file.path,
      text: file.text,
      hash: fileHash,
      status: known === undefined ? 'new' : known === fileHash ? 'unchanged' : 'changed',
      // A tier at any indentation counts — see frontmatter.js.
      needsTier: !keys.has('tier'),
      warnings: frontmatterWarnings(file.text),
    })
  }

  const unchanged = entries.filter((e) => e.status === 'unchanged')
  const touched = entries.filter((e) => e.status !== 'unchanged')

  // Only files that are new or edited are candidates for tiering: an untiered
  // file that has not changed since the last index was already considered.
  const tierCandidates = touched.filter((e) => e.needsTier)
  const toTier = tierCandidates.slice(0, cap)
  const deferred = tierCandidates.slice(cap)

  if (toTier.length) onProgress(`Classifying 0/${toTier.length}…`)

  let done = 0
  const classified = await mapPool(toTier, CLASSIFY_CONCURRENCY, async (entry) => {
    try {
      const result = await classify(entry.path, parseFrontmatter(entry.text).body)
      onProgress(`Classifying ${++done}/${toTier.length}…`)
      return { entry, result, error: null }
    } catch (error) {
      onProgress(`Classifying ${++done}/${toTier.length}…`)
      return { entry, result: null, error }
    }
  })

  const tierPlan = classified.map(({ entry, result, error }) => {
    if (error || !result) {
      return { ...entry, classifyError: error?.message ?? 'classification failed', patch: null }
    }

    // The single source of truth for both preview and write.
    const patch = appendFrontmatter(entry.text, {
      tier: result.tier,
      tier_by: 'gnosis',
    })

    return {
      ...entry,
      classifyError: null,
      proposedTier: result.tier,
      // Shown for context, deliberately not written — see the sync decisions.
      topicGuess: result.topic ?? null,
      sourceGuess: result.source ?? null,
      patch,
      chunks: chunkStats(parseFrontmatter(patch.text).body),
    }
  })

  // Files that are changing but already carry a tier: re-indexed, never written.
  const reindex = touched
    .filter((e) => !e.needsTier)
    .map((e) => ({ ...e, chunks: chunkStats(parseFrontmatter(e.text).body) }))

  const diskPaths = new Set(files.map((f) => f.path))
  const toRemove = [...indexed.keys()].filter((path) => !diskPaths.has(path))

  const allChunked = [...tierPlan.filter((e) => e.chunks), ...reindex]
  const oversized = allChunked
    .flatMap((e) => e.chunks.sizes.map((size) => ({ path: e.path, size })))
    .filter(({ size }) => size > MAX_CHARS)
    .sort((a, b) => b.size - a.size)

  return {
    entries,
    unchanged,
    toTier: tierPlan,
    deferred,
    reindex,
    toRemove,
    reportsToExport: reportsToExport(reports, existingReportFiles),
    chunks: {
      total: allChunked.reduce((sum, e) => sum + e.chunks.count, 0),
      largest: allChunked.reduce((m, e) => Math.max(m, e.chunks.max), 0),
      oversized,
    },
    cap,
  }
}
