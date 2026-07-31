/**
 * Clickable zones, derived from the map rather than hand-placed.
 *
 * A room is found by expanding from the character standing in it across
 * contiguous floor — the "flood fill" — with a guard that stops the fill
 * leaking through a one-tile doorway into the hallway. Move a character in the
 * editor and the clickable area follows; no coordinates to keep in sync.
 *
 * Pure: no canvas, no DOM.
 */

import { cellName, isFloor } from './grid.js'

/** Inset on a room zone, so adjacent rooms never share a boundary pixel. */
const ROOM_PAD = 0.3

/** A prop zone is a little larger than its tile, to be comfortably clickable. */
const PROP_PAD = 0.4

/**
 * Which tab each zone opens. The office is navigation, so this mapping is the
 * whole interaction — declared here as data rather than buried in a click
 * handler.
 */
export const ZONE_TABS = {
  finski: 'finski',
  dom: 'dom',
  gnosis: 'gnosis',
  dashboard: 'journal',
}

const ROOM_LABELS = {
  finski: 'Finski — Pre-market brief',
  dom: 'DOM — Post-trade analyst',
  gnosis: 'Gnosis — Knowledge base',
}

/**
 * The rectangle of contiguous floor containing `(sx, sy)`.
 *
 * Horizontal extent is taken along the starting row. Vertical extent only
 * grows while the next row is as wide as the room already is — that is what
 * keeps a room from bleeding out through a doorway, which is narrower than the
 * room by definition.
 *
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function roomBox(map, sx, sy) {
  if (!isFloor(map, sx, sy)) return null

  let minX = sx
  let maxX = sx
  let minY = sy
  let maxY = sy

  while (isFloor(map, minX - 1, sy)) minX--
  while (isFloor(map, maxX + 1, sy)) maxX++

  const width = maxX - minX + 1
  const rowIsFull = (y) => {
    let n = 0
    for (let x = minX; x <= maxX; x++) if (isFloor(map, x, y)) n++
    return n >= width
  }

  while (minY - 1 >= 0 && rowIsFull(minY - 1)) minY--
  while (maxY + 1 < map.rows && rowIsFull(maxY + 1)) maxY++

  return { minX, minY, maxX, maxY }
}

/** Where the reception zone sits: a glass door if placed, else Posty's sofa. */
function receptionCell(map) {
  const posty = map.chars?.posty
  let sofa = null

  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      const name = cellName(map, 'deco', x, y) ?? cellName(map, 'overlay', x, y)
      if (name === 'door_glass') return { x, y }
      if (!sofa && name === 'sofa2' && posty && Math.abs(y - posty.y) <= 2) {
        sofa = { x, y }
      }
    }
  }

  return sofa
}

/**
 * Every clickable zone on the map, in tile coordinates.
 *
 * The `exit` zone FlowJournal derived is deliberately absent: it linked out to
 * the old standalone app, and inside Mazevo there is nowhere for it to go.
 *
 * @returns {Array<{x: number, y: number, w: number, h: number, id: string, tab: string, label: string}>}
 */
export function deriveZones(map) {
  const zones = []
  const chars = map.chars ?? {}

  for (const id of ['finski', 'dom', 'gnosis']) {
    const character = chars[id]
    if (!character) continue

    const box = roomBox(map, character.x, character.y)
    if (!box) continue

    zones.push({
      x: box.minX + ROOM_PAD,
      y: box.minY + ROOM_PAD,
      w: box.maxX - box.minX + 1 - ROOM_PAD * 2,
      h: box.maxY - box.minY + 1 - ROOM_PAD * 2,
      id,
      tab: ZONE_TABS[id],
      label: ROOM_LABELS[id],
    })
  }

  const reception = receptionCell(map)
  if (reception) {
    zones.push({
      x: reception.x - PROP_PAD,
      y: reception.y - PROP_PAD,
      w: 1 + PROP_PAD * 2,
      h: 1 + PROP_PAD * 2,
      id: 'dashboard',
      tab: ZONE_TABS.dashboard,
      label: 'Reception — Open the journal',
    })
  }

  return zones
}

/**
 * The zone under a point in tile space, or null.
 *
 * First match wins, matching the render order — rooms are derived before
 * props, so a prop sitting inside a room does not steal its own room's click.
 */
export function zoneAt(zones, x, y) {
  for (const zone of zones) {
    if (x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h) {
      return zone
    }
  }
  return null
}
