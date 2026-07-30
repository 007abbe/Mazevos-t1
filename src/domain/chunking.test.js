import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkBody,
  MAX_CHARS,
  MIN_CHUNK_CHARS,
  TARGET_CHARS,
} from './chunking.js'

/** A paragraph of exactly `n` characters, distinguishable in assertions. */
const para = (n, mark = 'x') => mark.repeat(n)

const body = (...paragraphs) => paragraphs.join('\n\n')

// --- nothing to index -----------------------------------------------------

test('an empty or whitespace body yields no chunks', () => {
  assert.deepEqual(chunkBody(''), [])
  assert.deepEqual(chunkBody('   \n\n  \n'), [])
  assert.deepEqual(chunkBody(null), [])
  assert.deepEqual(chunkBody(undefined), [])
})

test('a stub note falls under the minimum and is dropped', () => {
  assert.deepEqual(chunkBody('# Title\n\nOne short line.'), [])
})

test('the minimum is exclusive — one character over survives', () => {
  assert.deepEqual(chunkBody(para(MIN_CHUNK_CHARS)), [])
  assert.deepEqual(chunkBody(para(MIN_CHUNK_CHARS + 1)), [para(MIN_CHUNK_CHARS + 1)])
})

// --- accumulation ---------------------------------------------------------

test('short paragraphs accumulate into one chunk, joined by a blank line', () => {
  const chunks = chunkBody(body(para(100, 'a'), para(100, 'b'), para(100, 'c')))

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], `${para(100, 'a')}\n\n${para(100, 'b')}\n\n${para(100, 'c')}`)
})

test('a chunk is flushed once it reaches the target', () => {
  const chunks = chunkBody(body(para(900, 'a'), para(900, 'b'), para(300, 'c')))

  assert.equal(chunks.length, 2)
  assert.ok(chunks[0].length >= TARGET_CHARS, 'first chunk reached the target')
  assert.equal(chunks[1], para(300, 'c'), 'the remainder is its own chunk')
})

test('a paragraph that would overshoot the max starts a new chunk instead', () => {
  // 1500 + 1500 + 2 = 3002, past the 2400 max, so these must not be merged.
  const chunks = chunkBody(body(para(1500, 'a'), para(1500, 'b')))

  assert.deepEqual(chunks, [para(1500, 'a'), para(1500, 'b')])
})

test('paragraphs stay whole — a chunk is never a partial paragraph', () => {
  const chunks = chunkBody(body(para(1000, 'a'), para(1000, 'b'), para(1000, 'c')))

  for (const chunk of chunks) {
    for (const paragraph of chunk.split('\n\n')) {
      assert.match(paragraph, /^(a+|b+|c+)$/, 'no paragraph was cut mid-way')
    }
  }
})

test('document order is preserved', () => {
  const chunks = chunkBody(
    body(para(900, 'a'), para(900, 'b'), para(900, 'c'), para(900, 'd'))
  )

  // Collapse each run of repeated characters to one, ignoring separators.
  const order = chunks
    .join('')
    .replace(/\s+/g, '')
    .match(/(.)\1*/g)
    .map((run) => run[0])
    .join('')

  assert.equal(order, 'abcd', 'paragraphs come back in document order')
})

test('every paragraph reaches exactly one chunk', () => {
  const paragraphs = ['a', 'b', 'c', 'd', 'e'].map((m) => para(700, m))
  const chunks = chunkBody(body(...paragraphs))

  for (const paragraph of paragraphs) {
    const hits = chunks.filter((c) => c.includes(paragraph)).length
    assert.equal(hits, 1, 'each paragraph appears once, in one chunk')
  }
})

// --- characterisation: the oversized-paragraph case -----------------------

test('a single paragraph past the max is emitted whole, over the limit', () => {
  // FlowJournal's behaviour, kept: paragraph boundaries are never broken, so a
  // table or fenced code block with no blank line inside it becomes one chunk
  // of unbounded size. Documented here so a change is a deliberate one.
  const huge = para(MAX_CHARS * 3)
  const chunks = chunkBody(huge)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].length, MAX_CHARS * 3)
  assert.ok(chunks[0].length > MAX_CHARS, 'exceeds the max rather than being split')
})

test('an oversized paragraph does not drag its neighbours over with it', () => {
  const chunks = chunkBody(body(para(5000, 'a'), para(200, 'b')))

  assert.equal(chunks[0], para(5000, 'a'))
  assert.equal(chunks[1], para(200, 'b'), 'the next paragraph starts a fresh chunk')
})

test('apart from that case, no chunk exceeds the max', () => {
  const paragraphs = Array.from({ length: 20 }, (_, i) =>
    para(200 + i * 37, String.fromCharCode(97 + (i % 26)))
  )
  const chunks = chunkBody(body(...paragraphs))

  for (const chunk of chunks) {
    assert.ok(chunk.length <= MAX_CHARS, `chunk of ${chunk.length} is within the max`)
  }
})

// --- whitespace and separators --------------------------------------------

test('chunks are trimmed', () => {
  const chunks = chunkBody(`   ${para(100, 'a')}   \n\n   ${para(100, 'b')}   `)

  for (const chunk of chunks) assert.equal(chunk, chunk.trim())
})

test('blank lines with stray whitespace still separate paragraphs', () => {
  const chunks = chunkBody(`${para(1500, 'a')}\n   \n${para(1500, 'b')}`)
  assert.deepEqual(chunks, [para(1500, 'a'), para(1500, 'b')])
})

test('CRLF paragraph breaks are recognised', () => {
  const chunks = chunkBody(`${para(1500, 'a')}\r\n\r\n${para(1500, 'b')}`)

  assert.equal(chunks.length, 2)
  assert.ok(!chunks[0].includes('b'), 'the break was honoured, not swallowed')
})

test('runs of blank lines collapse to a single separator', () => {
  const chunks = chunkBody(`${para(100, 'a')}\n\n\n\n${para(100, 'b')}`)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], `${para(100, 'a')}\n\n${para(100, 'b')}`)
})

// --- determinism and configurability --------------------------------------

test('chunking the same body twice gives the same chunks', () => {
  const text = body(...['a', 'b', 'c', 'd', 'e', 'f'].map((m) => para(600, m)))
  assert.deepEqual(chunkBody(text), chunkBody(text))
})

test('the size band is configurable for callers that need a different shape', () => {
  const text = body(para(100, 'a'), para(100, 'b'), para(100, 'c'))
  const chunks = chunkBody(text, { target: 150, max: 250, min: 10 })

  assert.ok(chunks.length > 1, 'a smaller target produces more chunks')
  for (const chunk of chunks) assert.ok(chunk.length <= 250)
})
