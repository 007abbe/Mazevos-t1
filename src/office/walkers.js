/**
 * The characters wandering the office.
 *
 * Deliberately languid: a walker sits idle for many seconds, then usually just
 * thinks rather than moving. The office should feel inhabited when glanced at,
 * not busy.
 *
 * The state machine is pure — `stepWalker` takes a random source and a
 * walkable grid and mutates only the walker it is given, so it can be driven
 * deterministically in tests.
 */

import { isWalkable } from './grid.js'
import { TILE_SIZE } from './scene.js'

/** Tiles either side of home a walker will wander. */
export const ROAM_RADIUS = 3

/** Pixels per frame. Slow on purpose. */
const SPEED = 0.7

/** Frames a walker stands still before it might act. */
const IDLE_MINIMUM = 60 * 8

/** Per-frame chance of acting once past the minimum — about once every 10s. */
const ACT_CHANCE = 0.0025

/** Of those actions, how often it walks rather than thinks. */
const WALK_CHANCE = 0.25

const THINK_FRAMES = 200
const PAUSE_FRAMES = 200
const STEP_FRAMES = 14
const ARRIVAL_PX = 2

/** Characters stand a little below centre so their feet meet the floor. */
const FOOT_OFFSET = 0.6

export function createWalkers(map) {
  return Object.entries(map.chars ?? {}).map(([id, { x, y }]) => {
    const anchorX = (x + 0.5) * TILE_SIZE
    const anchorY = (y + FOOT_OFFSET) * TILE_SIZE

    return {
      id,
      home: { x, y },
      anchor: { x: anchorX, y: anchorY },
      px: anchorX,
      py: anchorY,
      tx: anchorX,
      ty: anchorY,
      state: 'idle',
      dir: 'south',
      t: 0,
      frame: 0,
      frameTime: 0,
    }
  })
}

/** Aims the walker at a random walkable tile near home. Fails quietly. */
function pickTarget(walker, grid, random) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const span = ROAM_RADIUS * 2 + 1
    const tx = walker.home.x + Math.floor(random() * span) - ROAM_RADIUS
    const ty = walker.home.y + Math.floor(random() * span) - ROAM_RADIUS

    if (isWalkable(grid, tx, ty)) {
      walker.tx = (tx + 0.5) * TILE_SIZE
      walker.ty = (ty + FOOT_OFFSET) * TILE_SIZE
      return true
    }
  }
  return false
}

const facing = (dx, dy) =>
  Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : dy > 0 ? 'south' : 'north'

/** Advances one walker by a frame. */
export function stepWalker(walker, grid, random = Math.random) {
  walker.t++

  if (walker.state === 'idle') {
    if (walker.t > IDLE_MINIMUM && random() < ACT_CHANCE) {
      if (random() < WALK_CHANCE) {
        if (pickTarget(walker, grid, random)) walker.state = 'walk'
      } else {
        walker.state = 'think'
      }
      walker.t = 0
    }
    return
  }

  if (walker.state === 'think') {
    if (walker.t > THINK_FRAMES) {
      walker.state = 'idle'
      walker.dir = 'south'
      walker.t = 0
    }
    return
  }

  if (walker.state === 'pause') {
    // Stuck or finished somewhere that is not home: head back.
    if (walker.t > PAUSE_FRAMES) {
      walker.tx = walker.anchor.x
      walker.ty = walker.anchor.y
      walker.state = 'walk'
      walker.t = 0
    }
    return
  }

  // walking
  const dx = walker.tx - walker.px
  const dy = walker.ty - walker.py
  const distance = Math.hypot(dx, dy)

  if (distance < ARRIVAL_PX) {
    const home =
      Math.abs(walker.tx - walker.anchor.x) < 3 && Math.abs(walker.ty - walker.anchor.y) < 3
    walker.state = home ? 'idle' : 'pause'
    walker.dir = 'south'
    walker.t = 0
    return
  }

  const nx = walker.px + (dx / distance) * SPEED
  const ny = walker.py + (dy / distance) * SPEED

  // Check the tile being entered, not the one being left — otherwise a walker
  // can drift through a wall corner diagonally.
  if (isWalkable(grid, Math.floor(nx / TILE_SIZE), Math.floor(ny / TILE_SIZE))) {
    walker.px = nx
    walker.py = ny
  } else {
    walker.state = 'pause'
    walker.t = 0
  }

  walker.dir = facing(dx, dy)
  walker.frameTime++
  if (walker.frameTime > STEP_FRAMES) {
    walker.frame = 1 - walker.frame
    walker.frameTime = 0
  }
}

/** The sprite name for a walker's current state. */
export function walkerSprite(walker) {
  if (walker.state === 'think') return `${walker.id}_think`
  if (walker.state === 'walk' && walker.frame) return `${walker.id}_walk_${walker.dir}`
  return `${walker.id}_idle_${walker.dir}`
}
