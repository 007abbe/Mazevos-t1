/**
 * YAML frontmatter reading and append-only patching.
 *
 * This is the only code in Mazevo that modifies files in the Obsidian vault,
 * so its contract is deliberately narrow and enforced here rather than by
 * callers:
 *
 *   - a key already present is never overwritten, at any indentation
 *   - the existing frontmatter block is preserved byte for byte
 *   - the body is never touched
 *   - when nothing is added, the returned text is the input, unchanged
 *
 * `appendFrontmatter` returns both the new text and exactly what it added, so
 * the sync preview and the write are the same computation — they cannot drift.
 *
 * This is not a YAML parser. It reads flat `key: value` lines well enough to
 * answer "does this note already declare a tier?", and treats everything it
 * cannot confidently read as a reason not to write (see `frontmatterWarnings`).
 */

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/**
 * @typedef {object} Frontmatter
 * @property {boolean} hasFrontmatter
 * @property {string} raw the block's inner text, exactly as written
 * @property {Record<string,string>} data top-level `key: value` pairs
 * @property {Set<string>} keys every key seen, including indented ones
 * @property {string} body everything after the closing delimiter
 */

/** @returns {Frontmatter} */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  const match = source.match(BLOCK)

  if (!match) {
    return {
      hasFrontmatter: false,
      raw: '',
      data: {},
      keys: new Set(),
      body: source,
    }
  }

  const raw = match[1]
  const data = {}
  const keys = new Set()

  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue

    const rawKey = line.slice(0, colon)
    const key = rawKey.trim()
    // List items are values, not keys.
    if (!key || key.startsWith('-')) continue

    keys.add(key)

    // Only unindented lines are top-level. An indented key still counts as
    // "seen" above, so a nested `tier:` blocks a write rather than producing a
    // second, contradictory one.
    if (rawKey === key) {
      data[key] = line
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
    }
  }

  return { hasFrontmatter: true, raw, data, keys, body: source.slice(match[0].length) }
}

/** The line ending the file already uses, so a patch does not mix styles. */
const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n')

/**
 * Appends only the keys that are absent.
 *
 * @param {string} text the note, verbatim
 * @param {Record<string, string|number>} patch keys to add if missing
 * @returns {{text: string, added: Record<string,string>, skipped: string[]}}
 */
export function appendFrontmatter(text, patch) {
  const source = String(text ?? '')
  const { hasFrontmatter, raw, keys } = parseFrontmatter(source)

  const added = {}
  const skipped = []
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (keys.has(key)) skipped.push(key)
    else added[key] = String(value)
  }

  // Nothing to do: hand back the input untouched rather than a re-serialised
  // equivalent. Callers rely on this to skip the write entirely.
  if (!Object.keys(added).length) return { text: source, added, skipped }

  const eol = eolOf(source)
  const lines = Object.entries(added)
    .map(([key, value]) => `${key}: ${value}`)
    .join(eol)

  if (!hasFrontmatter) {
    return { text: `---${eol}${lines}${eol}---${eol}${eol}${source}`, added, skipped }
  }

  const match = source.match(BLOCK)
  return {
    // `raw` goes back verbatim — the existing block is never re-serialised.
    text: `---${eol}${raw}${eol}${lines}${eol}---${eol}${source.slice(match[0].length)}`,
    added,
    skipped,
  }
}

/**
 * Reasons to look at a note before letting Gnosis write to it. Surfaced per
 * row in the sync preview; none of these block a write on their own.
 */
export function frontmatterWarnings(text) {
  const source = String(text ?? '')
  const { hasFrontmatter, raw } = parseFrontmatter(source)
  if (!hasFrontmatter) return []

  const warnings = []
  const lines = raw.split(/\r?\n/)
  const seen = new Set()

  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const rawKey = line.slice(0, colon)
    const key = rawKey.trim()
    if (!key || key.startsWith('-')) continue

    if (rawKey !== key) warnings.push(`indented key "${key}" — read as nested, not top-level`)
    if (seen.has(key)) warnings.push(`duplicate key "${key}"`)
    seen.add(key)
  }

  if (lines.some((l) => /^\s*-\s+/.test(l))) {
    warnings.push('list values present — preserved verbatim, not parsed')
  }

  // A body opening with a horizontal rule can look exactly like a frontmatter
  // block. If most lines carry no colon, this probably is not frontmatter.
  const withColon = lines.filter((l) => l.includes(':')).length
  if (lines.length && withColon / lines.length < 0.5) {
    warnings.push('block may be body text, not frontmatter — check before writing')
  }

  return [...new Set(warnings)]
}
