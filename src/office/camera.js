/**
 * Camera geometry: which part of the grid is drawn, and how screen pixels map
 * back to tiles.
 *
 * The office occupies a fraction of the grid the editor happens to allocate, so
 * the canvas is cropped to the occupied area rather than sized to the whole
 * map. That crop is the auto-zoom — a small office fills the frame without
 * anyone setting a zoom level.
 *
 * Pure: no canvas, no DOM.
 */

import { LAYERS } from './grid.js'

/** Tiles of breathing room around the occupied area. */
export const MARGIN = 2

/**
 * Extra rows below the lowest occupied tile. Character sprites are drawn
 * taller than one tile and anchored at the feet, so without this the bottom
 * row of sprites is clipped.
 */
export const BOTTOM_EXTRA = 1

/**
 * The crop rectangle, in tiles.
 *
 * Considers every layer *and* character positions — a character standing past
 * the last painted tile still has to be on screen.
 *
 * @returns {{ox: number, oy: number, cols: number, rows: number}}
 */
export function computeCrop(map, { margin = MARGIN, bottomExtra = BOTTOM_EXTRA } = {}) {
  let minX = map.cols
  let minY = map.rows
  let maxX = 0
  let maxY = 0
  let occupied = false

  for (const layer of LAYERS) {
    const grid = map[layer] ?? []
    for (let y = 0; y < map.rows; y++) {
      for (let x = 0; x < map.cols; x++) {
        if (!(grid[y] && grid[y][x])) continue
        occupied = true
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  for (const character of Object.values(map.chars ?? {})) {
    occupied = true
    if (character.x < minX) minX = character.x
    if (character.x > maxX) maxX = character.x
    if (character.y < minY) minY = character.y
    if (character.y > maxY) maxY = character.y
  }

  // Nothing painted: show the whole grid rather than a zero-sized canvas.
  if (!occupied) return { ox: 0, oy: 0, cols: map.cols, rows: map.rows }

  const ox = Math.max(0, minX - margin)
  const oy = Math.max(0, minY - margin)

  return {
    ox,
    oy,
    cols: Math.min(map.cols, maxX + 1 + margin) - ox,
    rows: Math.min(map.rows, maxY + 1 + bottomExtra + margin) - oy,
  }
}

/** Canvas pixel dimensions for a crop. */
export const cropPixels = (crop, tileSize) => ({
  width: crop.cols * tileSize,
  height: crop.rows * tileSize,
})

/**
 * Uniform scale that fits the canvas inside its container.
 *
 * The canvas is rendered at native tile resolution and scaled with CSS
 * (`image-rendering: pixelated`), so this is a display concern only — the
 * backing store never changes size, and hit testing divides it back out.
 */
export function fitScale(canvasWidth, canvasHeight, containerWidth, containerHeight) {
  if (!canvasWidth || !canvasHeight) return 1
  return Math.min(containerWidth / canvasWidth, containerHeight / canvasHeight)
}

/**
 * A pointer event's position in tile coordinates.
 *
 * Three transforms compose here, and getting any one wrong misplaces every
 * click: subtract the element's origin, divide out the CSS scale (the ratio of
 * backing store to displayed size), then add the crop offset to get back to
 * absolute map tiles.
 *
 * @param {{clientX: number, clientY: number}} point
 * @param {{left: number, top: number, width: number, height: number}} rect displayed bounds
 * @param {{width: number, height: number}} canvas backing store size
 */
export function canvasPos(point, { rect, canvas, tileSize, crop }) {
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height

  return {
    x: ((point.clientX - rect.left) * scaleX) / tileSize + crop.ox,
    y: ((point.clientY - rect.top) * scaleY) / tileSize + crop.oy,
  }
}
