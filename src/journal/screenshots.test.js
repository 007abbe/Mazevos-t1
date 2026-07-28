import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fitDimensions,
  dataUrlBytes,
  isImageFile,
  MAX_DIMENSION,
  MAX_BYTES,
} from './screenshots.js'

test('fitDimensions scales the longest edge down to the cap', () => {
  assert.deepEqual(fitDimensions(3840, 2160, 1600), { width: 1600, height: 900 })
  assert.deepEqual(fitDimensions(2160, 3840, 1600), { width: 900, height: 1600 })
  assert.deepEqual(fitDimensions(2000, 2000, 1600), { width: 1600, height: 1600 })
})

test('fitDimensions never scales an image up', () => {
  assert.deepEqual(fitDimensions(800, 600, 1600), { width: 800, height: 600 })
  assert.deepEqual(fitDimensions(1, 1, 1600), { width: 1, height: 1 })
})

test('fitDimensions keeps aspect ratio within a rounding pixel', () => {
  for (const [w, h] of [[1920, 1080], [2560, 1440], [1366, 768], [3000, 1013]]) {
    const out = fitDimensions(w, h, MAX_DIMENSION)
    assert.ok(Math.abs(w / h - out.width / out.height) < 0.01, `${w}x${h} -> ${out.width}x${out.height}`)
    assert.ok(Math.max(out.width, out.height) <= MAX_DIMENSION)
  }
})

test('fitDimensions never rounds a thin edge away to zero', () => {
  const out = fitDimensions(4000, 3, 1600)
  assert.equal(out.width, 1600)
  assert.ok(out.height >= 1, 'a 1px-tall canvas still has to be drawable')
})

test('fitDimensions rejects degenerate sizes', () => {
  for (const [w, h] of [[0, 100], [100, 0], [-5, 100], [NaN, 100]]) {
    assert.throws(() => fitDimensions(w, h, 1600), RangeError)
  }
})

test('dataUrlBytes measures the decoded payload, not the string', () => {
  // "hello" -> aGVsbG8= : 5 bytes from 8 base64 chars.
  assert.equal(dataUrlBytes('data:image/jpeg;base64,aGVsbG8='), 5)
  assert.equal(dataUrlBytes('data:image/jpeg;base64,aGVsbG9h'), 6) // "helloa", no padding
  assert.equal(dataUrlBytes('data:image/jpeg;base64,aGVsbG8'), 5) // unpadded: floor(7*3/4)
})

test('dataUrlBytes handles empty and non-string input', () => {
  assert.equal(dataUrlBytes(''), 0)
  assert.equal(dataUrlBytes('data:image/jpeg;base64,'), 0)
  assert.equal(dataUrlBytes(null), 0)
  assert.equal(dataUrlBytes(undefined), 0)
})

test('dataUrlBytes is within a byte of the true size for real payloads', () => {
  for (const size of [1, 2, 3, 100, 999, 400_000]) {
    const buf = Buffer.alloc(size, 7)
    const url = `data:image/jpeg;base64,${buf.toString('base64')}`
    assert.equal(dataUrlBytes(url), size, `size ${size}`)
  }
})

test('the byte budget leaves room under a typical request limit', () => {
  // Base64 inflates by 4/3, so the encoded column value is what travels.
  const encoded = Math.ceil((MAX_BYTES * 4) / 3)
  assert.ok(encoded < 1_000_000, `${encoded} bytes on the wire should stay well under 1MB`)
})

test('isImageFile accepts images and rejects everything else', () => {
  assert.ok(isImageFile({ type: 'image/png' }))
  assert.ok(isImageFile({ type: 'image/jpeg' }))
  assert.ok(isImageFile({ type: 'image/webp' }))
  assert.ok(!isImageFile({ type: 'application/pdf' }))
  assert.ok(!isImageFile({ type: '' }))
  assert.ok(!isImageFile({}))
  assert.ok(!isImageFile(null))
  assert.ok(!isImageFile(undefined))
})
