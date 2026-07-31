import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWalkable, cellName, cellRotation, isFloor, isWalkable } from './grid.js'
import { floorMap, place } from './__fixtures__/map.js'

test('cellName reads bare names and the {n, r} form alike', () => {
  const map = floorMap('##', '##')
  place(map, 'deco', 0, 0, 'desk_trading')
  place(map, 'deco', 1, 0, { n: 'globe', r: 3 })

  assert.equal(cellName(map, 'deco', 0, 0), 'desk_trading')
  assert.equal(cellName(map, 'deco', 1, 0), 'globe')
})

test('cellName is null for empty cells, missing rows and missing layers', () => {
  const map = floorMap('##', '##')

  assert.equal(cellName(map, 'deco', 0, 0), null)
  assert.equal(cellName(map, 'deco', 99, 99), null)
  assert.equal(cellName(map, 'nonexistent', 0, 0), null)
})

test('cellRotation defaults to zero', () => {
  const map = floorMap('##')
  place(map, 'deco', 0, 0, { n: 'globe', r: 2 })
  place(map, 'deco', 1, 0, 'globe')

  assert.equal(cellRotation(map, 'deco', 0, 0), 2)
  assert.equal(cellRotation(map, 'deco', 1, 0), 0)
  assert.equal(cellRotation(map, 'deco', 5, 5), 0)
})

test('isFloor reads the floor layer and nothing else', () => {
  const map = floorMap('#.', '.#')
  place(map, 'deco', 1, 0, 'desk_trading') // furniture is not floor

  assert.equal(isFloor(map, 0, 0), true)
  assert.equal(isFloor(map, 1, 0), false)
  assert.equal(isFloor(map, 1, 1), true)
})

test('isFloor is bounds-checked in every direction', () => {
  const map = floorMap('##', '##')

  assert.equal(isFloor(map, -1, 0), false)
  assert.equal(isFloor(map, 0, -1), false)
  assert.equal(isFloor(map, 2, 0), false)
  assert.equal(isFloor(map, 0, 2), false)
})

test('the walkable grid mirrors the floor layer exactly', () => {
  const map = floorMap('#.#', '.#.')
  const grid = buildWalkable(map)

  assert.deepEqual(grid, [
    [true, false, true],
    [false, true, false],
  ])
})

test('the walkable grid covers the full map, including empty rows', () => {
  const map = floorMap('##', '..', '##')
  const grid = buildWalkable(map)

  assert.equal(grid.length, 3)
  assert.deepEqual(grid[1], [false, false], 'a void row is present, not skipped')
})

test('isWalkable refuses void, so a character never steps off the floor', () => {
  const grid = buildWalkable(floorMap('#.', '##'))

  assert.equal(isWalkable(grid, 0, 0), true)
  assert.equal(isWalkable(grid, 1, 0), false)
})

test('isWalkable refuses everything outside the grid', () => {
  const grid = buildWalkable(floorMap('##', '##'))

  assert.equal(isWalkable(grid, -1, 0), false)
  assert.equal(isWalkable(grid, 0, -1), false)
  assert.equal(isWalkable(grid, 2, 0), false)
  assert.equal(isWalkable(grid, 0, 2), false)
})
