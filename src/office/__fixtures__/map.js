/**
 * Test helper: build a map from ASCII art.
 *
 * Room geometry is the kind of thing that is obvious as a picture and opaque
 * as a nested array, and the doorway-leak guard in particular only makes sense
 * when you can see the doorway.
 *
 *   floorMap('.###.',
 *            '.#.#.')   // '#' is floor, anything else is void
 */
export function floorMap(...rows) {
  const cols = Math.max(...rows.map((r) => r.length))

  return {
    cols,
    rows: rows.length,
    floor: rows.map((row) =>
      Array.from({ length: cols }, (_, x) => (row[x] === '#' ? 'hf_wood' : null))
    ),
    wall: [],
    overlay: [],
    edge: [],
    deco: [],
    chars: {},
  }
}

/** Places a tile on a layer, returning the map for chaining. */
export function place(map, layer, x, y, name) {
  map[layer] ??= []
  map[layer][y] ??= []
  map[layer][y][x] = name
  return map
}

/** Places a character, returning the map for chaining. */
export function placeChar(map, id, x, y) {
  map.chars ??= {}
  map.chars[id] = { x, y }
  return map
}
