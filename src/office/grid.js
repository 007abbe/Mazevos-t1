/**
 * Map primitives for the office.
 *
 * The map (`office.json`) is five parallel layers of the same dimensions —
 * floor, wall, overlay, edge, deco — plus a `chars` map of starting positions.
 * A cell is either falsy, a bare tile name, or `{n, r}` with a rotation.
 *
 * Pure: no canvas, no DOM.
 */

export const LAYERS = ['floor', 'wall', 'overlay', 'edge', 'deco']

/** The tile name at a cell, or null. Accepts both the bare and `{n, r}` forms. */
export function cellName(map, layer, x, y) {
  const row = map?.[layer]?.[y]
  const cell = row && row[x]
  if (!cell) return null
  return cell.n ?? cell
}

/** Rotation in quarter-turns, 0 unless the cell carries one. */
export function cellRotation(map, layer, x, y) {
  const row = map?.[layer]?.[y]
  const cell = row && row[x]
  return (cell && cell.r) || 0
}

/**
 * Floor is the only layer that defines walkable, room-bounding space. Walls
 * and deco sit on top of it; void is the absence of it.
 */
export function isFloor(map, x, y) {
  if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return false
  return !!(map.floor?.[y] && map.floor[y][x])
}

/**
 * A dense boolean grid of walkable tiles, so the walker loop can test a tile
 * without re-reading the layer arrays every frame.
 */
export function buildWalkable(map) {
  const grid = []
  for (let y = 0; y < map.rows; y++) {
    const row = []
    for (let x = 0; x < map.cols; x++) row.push(isFloor(map, x, y))
    grid.push(row)
  }
  return grid
}

/** Bounds-checked lookup — characters never step onto void or through walls. */
export function isWalkable(grid, x, y) {
  return !!(grid[y] && grid[y][x])
}
