/**
 * Splits a note body into the chunks that get indexed and retrieved.
 *
 * Chunks are the unit of both full-text search and Ask retrieval, so the size
 * band is a retrieval-quality decision: small enough that a hit points at a
 * specific passage, large enough that the passage still carries its context.
 * Ported from trading-journal/index.html (`chunkBody`).
 *
 * Paragraph boundaries are never broken — a chunk is always a whole number of
 * paragraphs. See `chunkBody` for what that means for a very long one.
 *
 * Pure: no vault, no browser, no clock.
 */

/** Flush once a chunk reaches this size. */
export const TARGET_CHARS = 1600

/** Never start a chunk that would grow past this by adding another paragraph. */
export const MAX_CHARS = 2400

/**
 * Chunks at or below this are dropped. A stub note — a title and one line —
 * is not worth a search hit, and would dilute ranking for everything else.
 */
export const MIN_CHUNK_CHARS = 40

/**
 * @param {string} body the note body, frontmatter already removed
 * @returns {string[]} chunks in document order
 *
 * Because paragraphs are never split, a single paragraph longer than
 * `MAX_CHARS` is emitted whole and can exceed it without bound — a markdown
 * table or fenced code block with no blank lines inside it is one paragraph.
 * This is FlowJournal's behaviour, kept deliberately and characterised in the
 * tests rather than left implicit.
 */
export function chunkBody(
  body,
  { target = TARGET_CHARS, max = MAX_CHARS, min = MIN_CHUNK_CHARS } = {}
) {
  const paragraphs = String(body ?? '').split(/\n\s*\n/)

  const chunks = []
  let current = ''

  for (const paragraph of paragraphs) {
    // Adding this paragraph would overshoot: bank what we have and start over
    // from the paragraph itself.
    if (current && current.length + paragraph.length + 2 > max) {
      chunks.push(current.trim())
      current = paragraph
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph
    }

    if (current.length >= target) {
      chunks.push(current.trim())
      current = ''
    }
  }

  if (current.trim()) chunks.push(current.trim())

  return chunks.filter((chunk) => chunk.length > min)
}
