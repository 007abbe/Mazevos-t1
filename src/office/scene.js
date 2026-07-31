/**
 * The static scene: everything that never moves.
 *
 * Drawn once to an offscreen canvas, then blitted each frame. Only the walkers
 * and the hover highlight are redrawn per frame, so the cost of the office is
 * one image copy regardless of how much furniture is on the map.
 */

import { cellName, cellRotation, isFloor, LAYERS } from './grid.js'

export const TILE_SIZE = 64

/** Shows through anywhere no tile is drawn at all. */
const BACKDROP = '#26262b'

/** Deterministic scatter, so the concrete does not tile visibly. */
const concreteVariant = (x, y) => (((x * 7 + y * 13) % 11 < 3) ? 'void_concrete2' : 'void_concrete')

function drawTile(ctx, image, x, y, crop, rotation) {
  const px = x * TILE_SIZE - crop.ox * TILE_SIZE
  const py = y * TILE_SIZE - crop.oy * TILE_SIZE

  if (!rotation) {
    ctx.drawImage(image, px, py, TILE_SIZE, TILE_SIZE)
    return
  }

  ctx.save()
  ctx.translate(px + TILE_SIZE / 2, py + TILE_SIZE / 2)
  ctx.rotate((rotation * Math.PI) / 2)
  ctx.drawImage(image, -TILE_SIZE / 2, -TILE_SIZE / 2, TILE_SIZE, TILE_SIZE)
  ctx.restore()
}

/**
 * Renders the map into an offscreen canvas sized to `crop`.
 *
 * Void is filled with concrete first so the world reads as a floor plan cut out
 * of a larger building rather than tiles floating in space.
 */
export function drawScene(map, sprites, crop) {
  const canvas = document.createElement('canvas')
  canvas.width = crop.cols * TILE_SIZE
  canvas.height = crop.rows * TILE_SIZE

  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = BACKDROP
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      if (isFloor(map, x, y)) continue
      const image = sprites[concreteVariant(x, y)]
      if (image) drawTile(ctx, image, x, y, crop, 0)
    }
  }

  // Painter's order: the layers are stacked exactly as the editor stacks them.
  for (const layer of LAYERS) {
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) {
        const name = cellName(map, layer, x, y)
        const image = name && sprites[name]
        if (image) drawTile(ctx, image, x, y, crop, cellRotation(map, layer, x, y))
      }
    }
  }

  return canvas
}
