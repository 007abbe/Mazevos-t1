import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOTTOM_EXTRA,
  canvasPos,
  computeCrop,
  cropPixels,
  fitScale,
  MARGIN,
} from './camera.js'
import { floorMap, place, placeChar } from './__fixtures__/map.js'

const T = 64

// --- computeCrop ----------------------------------------------------------

test('the crop hugs the painted area with a margin, not the whole grid', () => {
  // Floor at x 4-6, y 3-4, inside a 20x12 grid.
  const map = { cols: 20, rows: 12, floor: [], wall: [], overlay: [], edge: [], deco: [], chars: {} }
  for (let y = 3; y <= 4; y++) for (let x = 4; x <= 6; x++) place(map, 'floor', x, y, 'hf_wood')

  assert.deepEqual(computeCrop(map), {
    ox: 4 - MARGIN,
    oy: 3 - MARGIN,
    cols: 6 + 1 + MARGIN - (4 - MARGIN),
    rows: 4 + 1 + BOTTOM_EXTRA + MARGIN - (3 - MARGIN),
  })
})

test('the crop clamps at the grid edges rather than going negative', () => {
  const map = floorMap('##', '##')
  const crop = computeCrop(map)

  assert.equal(crop.ox, 0)
  assert.equal(crop.oy, 0)
  assert.equal(crop.cols, 2, 'cannot extend past the right edge')
  assert.equal(crop.rows, 2, 'cannot extend past the bottom edge')
})

test('every layer counts toward the bounds, not just floor', () => {
  const bare = { cols: 20, rows: 20, floor: [], wall: [], overlay: [], edge: [], deco: [], chars: {} }

  for (const layer of ['wall', 'overlay', 'edge', 'deco']) {
    const map = { ...bare, [layer]: [] }
    place(map, layer, 10, 10, 'thing')
    const crop = computeCrop(map)

    assert.equal(crop.ox, 10 - MARGIN, `${layer} moved the left edge`)
    assert.equal(crop.oy, 10 - MARGIN, `${layer} moved the top edge`)
  }
})

test('a character past the last painted tile is still in frame', () => {
  const map = floorMap('###.......', '###.......')
  placeChar(map, 'finski', 8, 1)

  const crop = computeCrop(map)
  assert.ok(crop.ox + crop.cols > 8, 'the crop reaches the character')
})

test('extra rows are reserved below for character sprite height', () => {
  const map = { cols: 12, rows: 12, floor: [], wall: [], overlay: [], edge: [], deco: [], chars: {} }
  place(map, 'floor', 5, 5, 'hf_wood')

  const withExtra = computeCrop(map)
  const without = computeCrop(map, { bottomExtra: 0 })

  assert.equal(withExtra.rows - without.rows, BOTTOM_EXTRA)
  assert.equal(withExtra.cols, without.cols, 'only the bottom is padded')
})

test('an empty map falls back to the whole grid rather than nothing', () => {
  const map = { cols: 9, rows: 7, floor: [], wall: [], overlay: [], edge: [], deco: [], chars: {} }

  assert.deepEqual(computeCrop(map), { ox: 0, oy: 0, cols: 9, rows: 7 })
})

test('the margin is configurable', () => {
  const map = { cols: 20, rows: 20, floor: [], wall: [], overlay: [], edge: [], deco: [], chars: {} }
  place(map, 'floor', 10, 10, 'hf_wood')

  assert.equal(computeCrop(map, { margin: 0 }).ox, 10)
  assert.equal(computeCrop(map, { margin: 5 }).ox, 5)
})

test('cropPixels converts tiles to backing-store pixels', () => {
  assert.deepEqual(cropPixels({ ox: 2, oy: 1, cols: 10, rows: 6 }, T), {
    width: 640,
    height: 384,
  })
})

// --- fitScale -------------------------------------------------------------

test('fitScale picks the tighter of the two axes', () => {
  assert.equal(fitScale(1000, 500, 500, 500), 0.5, 'width constrained')
  assert.equal(fitScale(500, 1000, 500, 500), 0.5, 'height constrained')
})

test('fitScale enlarges when there is room', () => {
  assert.equal(fitScale(100, 100, 300, 200), 2)
})

test('fitScale survives a container that has not been laid out yet', () => {
  assert.equal(fitScale(0, 0, 500, 500), 1, 'no canvas yet')
  assert.equal(fitScale(100, 100, 0, 0), 0, 'zero-sized container')
})

// --- canvasPos ------------------------------------------------------------

const view = (overrides = {}) => ({
  rect: { left: 0, top: 0, width: 640, height: 384 },
  canvas: { width: 640, height: 384 },
  tileSize: T,
  crop: { ox: 0, oy: 0 },
  ...overrides,
})

test('at 1:1 with no offset, pixels map straight to tiles', () => {
  assert.deepEqual(canvasPos({ clientX: 0, clientY: 0 }, view()), { x: 0, y: 0 })
  assert.deepEqual(canvasPos({ clientX: 64, clientY: 128 }, view()), { x: 1, y: 2 })
  assert.deepEqual(canvasPos({ clientX: 96, clientY: 96 }, view()), { x: 1.5, y: 1.5 })
})

test('the element origin is subtracted', () => {
  const v = view({ rect: { left: 100, top: 50, width: 640, height: 384 } })

  assert.deepEqual(canvasPos({ clientX: 100, clientY: 50 }, v), { x: 0, y: 0 })
  assert.deepEqual(canvasPos({ clientX: 164, clientY: 50 }, v), { x: 1, y: 0 })
})

test('CSS scaling is divided back out', () => {
  // Displayed at half size: a click 64px in is 128 backing-store pixels, 2 tiles.
  const v = view({ rect: { left: 0, top: 0, width: 320, height: 192 } })

  assert.deepEqual(canvasPos({ clientX: 64, clientY: 64 }, v), { x: 2, y: 2 })
})

test('the crop offset puts the point back in absolute map coordinates', () => {
  const v = view({ crop: { ox: 3, oy: 5 } })

  assert.deepEqual(canvasPos({ clientX: 0, clientY: 0 }, v), { x: 3, y: 5 })
  assert.deepEqual(canvasPos({ clientX: 64, clientY: 64 }, v), { x: 4, y: 6 })
})

test('all three transforms compose', () => {
  const v = view({
    rect: { left: 20, top: 10, width: 320, height: 192 }, // half scale, offset
    crop: { ox: 3, oy: 5 },
  })

  // 32 CSS px past the origin → 64 backing px → 1 tile → plus the crop offset.
  assert.deepEqual(canvasPos({ clientX: 52, clientY: 42 }, v), { x: 4, y: 6 })
})

test('a click round-trips to the zone it visually lands on', () => {
  const map = floorMap('.####.', '.####.', '.####.')
  placeChar(map, 'finski', 2, 1)

  const crop = computeCrop(map)
  const { width, height } = cropPixels(crop, T)
  const v = {
    rect: { left: 0, top: 0, width, height },
    canvas: { width, height },
    tileSize: T,
    crop,
  }

  // Centre of tile (2,1) on screen, given the crop offset.
  const px = (2 - crop.ox) * T + T / 2
  const py = (1 - crop.oy) * T + T / 2
  const point = canvasPos({ clientX: px, clientY: py }, v)

  assert.equal(point.x, 2.5)
  assert.equal(point.y, 1.5)
})
