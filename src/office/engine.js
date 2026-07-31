/**
 * The office runtime: load, render, respond to the pointer, and — importantly —
 * stop cleanly.
 *
 * A canvas view inside a tabbed shell has to tear down. Left running, the
 * animation loop keeps drawing a detached canvas at 60fps for the rest of the
 * session, and the ResizeObserver keeps a reference to a dead element. Every
 * resource acquired in `mount` is released in the returned teardown.
 */

import { loadMap, loadSprites } from './assets.js'
import { canvasPos, computeCrop, cropPixels, fitScale } from './camera.js'
import { buildWalkable } from './grid.js'
import { drawScene, TILE_SIZE } from './scene.js'
import { createWalkers, stepWalker, walkerSprite } from './walkers.js'
import { deriveZones, zoneAt } from './zones.js'

/** Character sprites are drawn larger than a tile, anchored at the feet. */
const SPRITE_SIZE = 92
const SPRITE_OFFSET_X = 46
const SPRITE_OFFSET_Y = 82

const HIGHLIGHT_STROKE = 'rgba(34, 211, 238, 0.9)'
const HIGHLIGHT_FILL = 'rgba(34, 211, 238, 0.06)'

/**
 * Starts the office inside `el`.
 *
 * @param {HTMLElement} el
 * @param {(tabId: string) => void} navigate
 * @returns {Promise<() => void>} teardown
 */
export async function startOffice(el, navigate) {
  const [sprites, map] = await Promise.all([loadSprites(), loadMap()])

  const crop = computeCrop(map)
  const { width, height } = cropPixels(crop, TILE_SIZE)
  const zones = deriveZones(map)
  const walkGrid = buildWalkable(map)
  const walkers = createWalkers(map)
  const scene = drawScene(map, sprites, crop)

  el.innerHTML = `
    <div class="office-stage">
      <canvas class="office-canvas" width="${width}" height="${height}"></canvas>
      <div class="office-tip" hidden></div>
    </div>
  `

  const stage = el.querySelector('.office-stage')
  const canvas = el.querySelector('.office-canvas')
  const tip = el.querySelector('.office-tip')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  let hovered = null
  let frame = null
  let stopped = false

  const view = () => ({
    rect: canvas.getBoundingClientRect(),
    canvas: { width, height },
    tileSize: TILE_SIZE,
    crop,
  })

  function draw() {
    if (stopped) return

    ctx.drawImage(scene, 0, 0)

    if (hovered) {
      const x = (hovered.x - crop.ox) * TILE_SIZE
      const y = (hovered.y - crop.oy) * TILE_SIZE
      const w = hovered.w * TILE_SIZE
      const h = hovered.h * TILE_SIZE

      ctx.strokeStyle = HIGHLIGHT_STROKE
      ctx.lineWidth = 3
      ctx.strokeRect(x + 2, y + 2, w - 4, h - 4)
      ctx.fillStyle = HIGHLIGHT_FILL
      ctx.fillRect(x + 2, y + 2, w - 4, h - 4)
    }

    for (const walker of walkers) {
      stepWalker(walker, walkGrid)
      const image = sprites[walkerSprite(walker)]
      if (!image) continue

      ctx.drawImage(
        image,
        walker.px - crop.ox * TILE_SIZE - SPRITE_OFFSET_X,
        walker.py - crop.oy * TILE_SIZE - SPRITE_OFFSET_Y,
        SPRITE_SIZE,
        SPRITE_SIZE
      )
    }

    frame = requestAnimationFrame(draw)
  }

  const onMove = (event) => {
    const point = canvasPos(event, view())
    hovered = zoneAt(zones, point.x, point.y)

    canvas.style.cursor = hovered ? 'pointer' : 'default'
    tip.hidden = !hovered

    if (hovered) {
      const rect = stage.getBoundingClientRect()
      tip.textContent = hovered.label
      tip.style.left = `${event.clientX - rect.left + 14}px`
      tip.style.top = `${event.clientY - rect.top + 12}px`
    }
  }

  const onLeave = () => {
    hovered = null
    tip.hidden = true
  }

  const onClick = (event) => {
    const point = canvasPos(event, view())
    const zone = zoneAt(zones, point.x, point.y)
    if (zone) navigate(zone.tab)
  }

  const fit = () => {
    const scale = fitScale(width, height, stage.clientWidth, stage.clientHeight)
    canvas.style.width = `${width * scale}px`
    canvas.style.height = `${height * scale}px`
  }

  canvas.addEventListener('mousemove', onMove)
  canvas.addEventListener('mouseleave', onLeave)
  canvas.addEventListener('click', onClick)

  const observer = new ResizeObserver(fit)
  observer.observe(stage)
  fit()

  frame = requestAnimationFrame(draw)

  return () => {
    stopped = true
    if (frame !== null) cancelAnimationFrame(frame)
    observer.disconnect()
    canvas.removeEventListener('mousemove', onMove)
    canvas.removeEventListener('mouseleave', onLeave)
    canvas.removeEventListener('click', onClick)
  }
}
