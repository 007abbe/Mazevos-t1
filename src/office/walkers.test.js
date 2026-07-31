import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWalkers, ROAM_RADIUS, stepWalker, walkerSprite } from './walkers.js'
import { buildWalkable } from './grid.js'
import { TILE_SIZE } from './scene.js'
import { floorMap, placeChar } from './__fixtures__/map.js'

/** Returns the given values in order, then repeats the last one. */
const scripted = (...values) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

const openRoom = () => floorMap('######', '######', '######', '######', '######')

const walkerAt = (map, x, y) => {
  placeChar(map, 'finski', x, y)
  return createWalkers(map)[0]
}

test('a walker starts at its home tile, idle and facing the viewer', () => {
  const walker = walkerAt(openRoom(), 2, 3)

  assert.equal(walker.state, 'idle')
  assert.equal(walker.dir, 'south')
  assert.equal(walker.px, 2.5 * TILE_SIZE)
  assert.deepEqual(walker.home, { x: 2, y: 3 })
  assert.equal(walker.px, walker.tx, 'not going anywhere yet')
})

test('one walker per character on the map', () => {
  const map = openRoom()
  placeChar(map, 'finski', 1, 1)
  placeChar(map, 'dom', 2, 1)
  placeChar(map, 'posty', 3, 1)

  assert.deepEqual(
    createWalkers(map).map((w) => w.id),
    ['finski', 'dom', 'posty']
  )
})

test('a walker stands still for a long while before it can act', () => {
  const map = openRoom()
  const walker = walkerAt(map, 2, 2)
  const grid = buildWalkable(map)
  const eager = () => 0 // always passes every probability check

  for (let i = 0; i < 60 * 8; i++) stepWalker(walker, grid, eager)

  assert.equal(walker.state, 'idle', 'the minimum idle time is respected')
})

test('once past the minimum, a walker usually thinks rather than moves', () => {
  const map = openRoom()
  const walker = walkerAt(map, 2, 2)
  const grid = buildWalkable(map)

  walker.t = 60 * 8 + 1
  // First draw passes the act check; second exceeds the walk chance.
  stepWalker(walker, grid, scripted(0, 0.9))

  assert.equal(walker.state, 'think')
})

test('a thinking walker returns to idle', () => {
  const map = openRoom()
  const walker = walkerAt(map, 2, 2)
  const grid = buildWalkable(map)

  walker.state = 'think'
  walker.t = 201
  stepWalker(walker, grid, () => 1)

  assert.equal(walker.state, 'idle')
  assert.equal(walker.t, 0)
})

test('a walking walker moves toward its target and faces the right way', () => {
  const map = openRoom()
  const walker = walkerAt(map, 1, 2)
  const grid = buildWalkable(map)

  walker.state = 'walk'
  walker.tx = 4.5 * TILE_SIZE
  const before = walker.px

  stepWalker(walker, grid, () => 1)

  assert.ok(walker.px > before, 'moved toward the target')
  assert.equal(walker.dir, 'east')
})

test('a walker never steps onto void', () => {
  // Floor at x=0 only; everything east is void.
  const map = floorMap('#.')
  const walker = walkerAt(map, 0, 0)
  const grid = buildWalkable(map)

  walker.state = 'walk'
  walker.px = TILE_SIZE - 0.1 // right at the edge
  walker.tx = 5 * TILE_SIZE // somewhere out in the void
  const before = walker.px

  stepWalker(walker, grid, () => 1)

  assert.equal(walker.state, 'pause', 'stopped rather than walking off the floor')
  assert.equal(walker.px, before, 'did not move')
})

test('a paused walker eventually heads home', () => {
  const map = openRoom()
  const walker = walkerAt(map, 2, 2)
  const grid = buildWalkable(map)

  walker.state = 'pause'
  walker.t = 201
  stepWalker(walker, grid, () => 1)

  assert.equal(walker.state, 'walk')
  assert.equal(walker.tx, walker.anchor.x, 'aimed back at its anchor')
})

test('arriving home returns a walker to idle', () => {
  const map = openRoom()
  const walker = walkerAt(map, 2, 2)
  const grid = buildWalkable(map)

  walker.state = 'walk'
  walker.px = walker.anchor.x
  walker.py = walker.anchor.y
  walker.tx = walker.anchor.x
  walker.ty = walker.anchor.y

  stepWalker(walker, grid, () => 1)

  assert.equal(walker.state, 'idle')
  assert.equal(walker.dir, 'south')
})

test('arriving away from home pauses instead of idling', () => {
  const map = openRoom()
  const walker = walkerAt(map, 1, 1)
  const grid = buildWalkable(map)

  walker.state = 'walk'
  walker.px = 4.5 * TILE_SIZE
  walker.py = walker.anchor.y
  walker.tx = walker.px
  walker.ty = walker.py

  stepWalker(walker, grid, () => 1)

  assert.equal(walker.state, 'pause')
})

test('a chosen target is always walkable and within the roam radius', () => {
  const map = openRoom()
  const walker = walkerAt(map, 2, 2)
  const grid = buildWalkable(map)

  for (let run = 0; run < 200; run++) {
    walker.state = 'idle'
    walker.t = 60 * 8 + 1
    stepWalker(walker, grid, Math.random)

    if (walker.state !== 'walk') continue

    const tx = Math.floor(walker.tx / TILE_SIZE)
    const ty = Math.floor(walker.ty / TILE_SIZE)

    assert.ok(grid[ty]?.[tx], `target (${tx},${ty}) must be floor`)
    assert.ok(Math.abs(tx - walker.home.x) <= ROAM_RADIUS, 'within roam radius')
    assert.ok(Math.abs(ty - walker.home.y) <= ROAM_RADIUS, 'within roam radius')
  }
})

test('a walker boxed in on all sides simply stays put', () => {
  const map = floorMap('#')
  const walker = walkerAt(map, 0, 0)
  const grid = buildWalkable(map)

  walker.t = 60 * 8 + 1
  stepWalker(walker, grid, scripted(0, 0)) // wants to walk, but nowhere to go

  assert.notEqual(walker.state, 'walk', 'no walkable target, so no walk')
})

// --- sprite selection -----------------------------------------------------

test('the sprite name follows the walker state and facing', () => {
  const base = { id: 'dom', state: 'idle', dir: 'south', frame: 0 }

  assert.equal(walkerSprite(base), 'dom_idle_south')
  assert.equal(walkerSprite({ ...base, dir: 'east' }), 'dom_idle_east')
  assert.equal(walkerSprite({ ...base, state: 'think' }), 'dom_think')
  assert.equal(walkerSprite({ ...base, state: 'walk', frame: 1 }), 'dom_walk_south')
})

test('walking alternates between the walk and idle frames', () => {
  const walking = { id: 'finski', state: 'walk', dir: 'north', frame: 0 }

  assert.equal(walkerSprite(walking), 'finski_idle_north', 'the off beat')
  assert.equal(walkerSprite({ ...walking, frame: 1 }), 'finski_walk_north', 'the step')
})

test('a paused walker uses its idle sprite', () => {
  assert.equal(
    walkerSprite({ id: 'posty', state: 'pause', dir: 'west', frame: 1 }),
    'posty_idle_west'
  )
})
