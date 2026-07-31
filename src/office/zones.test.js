import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveZones, roomBox, zoneAt, ZONE_TABS } from './zones.js'
import { floorMap, place, placeChar } from './__fixtures__/map.js'

// --- roomBox --------------------------------------------------------------

test('a rectangular room is found from anywhere inside it', () => {
  const map = floorMap(
    '......',
    '.####.',
    '.####.',
    '.####.',
    '......'
  )

  const expected = { minX: 1, minY: 1, maxX: 4, maxY: 3 }
  assert.deepEqual(roomBox(map, 1, 1), expected, 'from the top-left corner')
  assert.deepEqual(roomBox(map, 3, 2), expected, 'from the middle')
  assert.deepEqual(roomBox(map, 4, 3), expected, 'from the bottom-right corner')
})

test('a point on void is not in any room', () => {
  const map = floorMap('.##.', '.##.')
  assert.equal(roomBox(map, 0, 0), null)
})

test('a point outside the grid is not in any room', () => {
  const map = floorMap('##', '##')
  assert.equal(roomBox(map, -1, 0), null)
  assert.equal(roomBox(map, 9, 0), null)
  assert.equal(roomBox(map, 0, 9), null)
})

test('THE DOORWAY GUARD: a room does not leak through a one-tile door', () => {
  // A four-wide room, a one-tile doorway below it, then the hallway. Contiguous
  // floor runs all the way down, so a plain flood fill would swallow the hall
  // and the room's zone would cover half the map.
  const map = floorMap(
    '.####.',
    '.####.',
    '..#...', // the doorway: 1 tile of the room's 4
    '######' // hallway
  )

  assert.deepEqual(
    roomBox(map, 2, 0),
    { minX: 1, minY: 0, maxX: 4, maxY: 1 },
    'stops at the doorway row, which is narrower than the room'
  )
})

test('a room does open into a corridor exactly as wide as itself', () => {
  // The guard is about width, not about doors: a full-width opening is not a
  // doorway, and the room legitimately continues.
  const map = floorMap('.####.', '.####.', '.####.')

  assert.deepEqual(roomBox(map, 2, 0), { minX: 1, minY: 0, maxX: 4, maxY: 2 })
})

test('a room grows upward as well as downward', () => {
  const map = floorMap(
    '.###.',
    '.###.',
    '.###.',
    '..#..'
  )

  assert.deepEqual(roomBox(map, 2, 2), { minX: 1, minY: 0, maxX: 3, maxY: 2 })
})

test('a one-tile corridor is its own room', () => {
  const map = floorMap('..#..', '..#..', '..#..')
  assert.deepEqual(roomBox(map, 2, 1), { minX: 2, minY: 0, maxX: 2, maxY: 2 })
})

test('two rooms separated by void stay separate', () => {
  const map = floorMap('.##..##.', '.##..##.')

  assert.deepEqual(roomBox(map, 1, 0), { minX: 1, minY: 0, maxX: 2, maxY: 1 })
  assert.deepEqual(roomBox(map, 5, 0), { minX: 5, minY: 0, maxX: 6, maxY: 1 })
})

test('a room flush against the grid edges is bounded by them', () => {
  const map = floorMap('###', '###')
  assert.deepEqual(roomBox(map, 0, 0), { minX: 0, minY: 0, maxX: 2, maxY: 1 })
})

// --- deriveZones ----------------------------------------------------------

const threeRooms = () => {
  const map = floorMap(
    '.####..####..####.',
    '.####..####..####.',
    '.####..####..####.'
  )
  placeChar(map, 'finski', 2, 1)
  placeChar(map, 'dom', 8, 1)
  placeChar(map, 'gnosis', 14, 1)
  return map
}

test('one zone per character, sized to the room they stand in', () => {
  const zones = deriveZones(threeRooms())

  assert.deepEqual(
    zones.map((z) => z.id),
    ['finski', 'dom', 'gnosis']
  )

  const finski = zones[0]
  // Room spans x 1-4, y 0-2, inset by the padding on every side.
  assert.equal(finski.x, 1.3)
  assert.equal(finski.y, 0.3)
  assert.equal(Math.round(finski.w * 10) / 10, 3.4)
  assert.equal(Math.round(finski.h * 10) / 10, 2.4)
})

test('each room zone carries the tab it opens', () => {
  const zones = deriveZones(threeRooms())

  assert.deepEqual(
    Object.fromEntries(zones.map((z) => [z.id, z.tab])),
    { finski: 'finski', dom: 'dom', gnosis: 'gnosis' }
  )
})

test('a character with no room produces no zone', () => {
  const map = floorMap('.###.', '.###.')
  placeChar(map, 'finski', 2, 0)
  placeChar(map, 'dom', 0, 0) // standing on void

  const zones = deriveZones(map)
  assert.deepEqual(
    zones.map((z) => z.id),
    ['finski']
  )
})

test('a map with no characters yields no room zones', () => {
  assert.deepEqual(deriveZones(floorMap('####', '####')), [])
})

test('the exit zone is deliberately not derived', () => {
  const map = floorMap('####', '####')
  place(map, 'overlay', 1, 1, 'sign_exit')
  place(map, 'deco', 2, 1, 'wall_exit2')

  const zones = deriveZones(map)
  assert.ok(!zones.some((z) => z.id === 'exit'), 'nothing in the app for it to open')
})

// --- reception ------------------------------------------------------------

test('a glass door becomes the reception zone, opening the journal', () => {
  const map = floorMap('#####', '#####')
  place(map, 'deco', 3, 1, 'door_glass')

  const [zone] = deriveZones(map)

  assert.equal(zone.id, 'dashboard')
  assert.equal(zone.tab, 'journal')
  assert.equal(zone.x, 2.6)
  assert.equal(zone.y, 0.6)
  assert.equal(Math.round(zone.w * 10) / 10, 1.8)
})

test('without a glass door, a sofa near Posty stands in', () => {
  const map = floorMap('#####', '#####', '#####')
  place(map, 'deco', 1, 1, 'sofa2')
  placeChar(map, 'posty', 1, 2)

  const [zone] = deriveZones(map)
  assert.equal(zone.id, 'dashboard')
})

test('a sofa far from Posty is just furniture', () => {
  const map = floorMap('#####', '#####', '#####', '#####', '#####')
  place(map, 'deco', 1, 0, 'sofa2')
  placeChar(map, 'posty', 1, 4) // four rows away, past the threshold

  assert.deepEqual(deriveZones(map), [])
})

test('a sofa with no Posty at all is just furniture', () => {
  const map = floorMap('#####', '#####')
  place(map, 'deco', 1, 1, 'sofa2')

  assert.deepEqual(deriveZones(map), [])
})

test('the glass door wins over a sofa', () => {
  const map = floorMap('#####', '#####')
  place(map, 'deco', 1, 1, 'sofa2')
  place(map, 'deco', 4, 1, 'door_glass')
  placeChar(map, 'posty', 1, 1)

  const [zone] = deriveZones(map)
  assert.equal(zone.x, 3.6, 'positioned on the door, not the sofa')
})

test('reception tiles are read from the overlay layer too', () => {
  const map = floorMap('#####', '#####')
  place(map, 'overlay', 2, 1, 'door_glass')

  assert.equal(deriveZones(map)[0]?.id, 'dashboard')
})

test('cells written as {n, r} are read the same as bare names', () => {
  const map = floorMap('#####', '#####')
  place(map, 'deco', 2, 1, { n: 'door_glass', r: 2 })

  assert.equal(deriveZones(map)[0]?.id, 'dashboard')
})

// --- zoneAt ---------------------------------------------------------------

test('zoneAt finds the zone under a point', () => {
  const zones = deriveZones(threeRooms())

  assert.equal(zoneAt(zones, 2, 1)?.id, 'finski')
  assert.equal(zoneAt(zones, 8, 1)?.id, 'dom')
  assert.equal(zoneAt(zones, 14, 1)?.id, 'gnosis')
})

test('zoneAt returns null in the gaps between rooms', () => {
  const zones = deriveZones(threeRooms())

  assert.equal(zoneAt(zones, 5.5, 1), null, 'the corridor between two rooms')
  assert.equal(zoneAt(zones, 2, 9), null, 'below every room')
})

test('the inset means the very edge of a room is not clickable', () => {
  const zones = deriveZones(threeRooms())

  assert.equal(zoneAt(zones, 1.0, 1), null, 'left edge falls in the padding')
  assert.equal(zoneAt(zones, 1.3, 1)?.id, 'finski', 'just inside is a hit')
})

test('every derived zone names a tab that exists in the mapping', () => {
  const map = threeRooms()
  place(map, 'deco', 0, 0, 'door_glass')

  for (const zone of deriveZones(map)) {
    assert.ok(Object.values(ZONE_TABS).includes(zone.tab), `${zone.id} → ${zone.tab}`)
  }
})
