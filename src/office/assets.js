/**
 * Sprite manifest and loader.
 *
 * Assets live in `public/office/` rather than the bundle: they are 87 static
 * PNGs that never change between builds, so Vite copies them verbatim and the
 * browser caches them independently of the JS.
 */

const BASE = () => `${import.meta.env?.BASE_URL ?? '/'}office/`

/** Tiles, furniture and fixtures. Names are the keys the map layers use. */
export const TILES = [
  'hf_wood', 'hf_wood2', 'hf_herring', 'hf_herring2', 'hf_carpet', 'hf_carpet2',
  'hf_marble', 'hf_marble2', 'hf_wall', 'hf_wall_chart', 'hf_wall_marble',
  'hf_wall_dark', 'hf_win_a', 'hf_win_b', 'hf_win_c', 'hf_door_open', 'hf_poster',
  'hf_cabinet', 'hf_rug', 'hf_winsmall',
  'door_main', 'door_glass', 'sign_dom', 'sign_finski', 'sign_gnosis', 'sign_exit', 'arrow',
  'desk_wizard', 'desk_trading', 'shelf_a', 'shelf_b', 'table_books', 'globe',
  'clock_white', 'rug', 'plant_t',
  'wall2_wood', 'wall2_wood2', 'wall2_slat', 'wall2_dark', 'wall2_light', 'wall2_glass',
  'win2_wide', 'win2_city', 'win2_corner', 'win2_wood', 'win2_tall',
  'winS_framed', 'winS_round', 'winS_small', 'winS_slim',
  'wall_clock2', 'clock2', 'wall_bench', 'wall_shelf_open', 'wall_exit2',
  'wall_door_wood', 'wall_door2',
  'desk2_dual', 'desk2_trader', 'desk2_screens', 'shelf2_tall', 'shelf2_a', 'shelf2_b',
  'books_stack', 'globe2', 'plant_small', 'plant_big', 'sofa2', 'lamp2', 'coffee2',
  'cooler2', 'board2',
  'void_concrete', 'void_concrete2', 'edge_wall', 'edge_corner',
  'trim_top', 'trim_bottom', 'trim_left', 'trim_right',
  'trim_corner_tl', 'trim_corner_tr', 'trim_corner_bl', 'trim_corner_br', 'trim_frame',
]

export const CHARACTERS = ['dom', 'finski', 'gnosis', 'posty']
const DIRECTIONS = ['south', 'north', 'east', 'west']

/** Every character frame name: four directions × idle/walk, plus a think pose. */
export const CHARACTER_SPRITES = CHARACTERS.flatMap((name) => [
  ...DIRECTIONS.flatMap((d) => [`${name}_idle_${d}`, `${name}_walk_${d}`]),
  `${name}_think`,
])

const spritePath = (name) =>
  CHARACTER_SPRITES.includes(name) ? `${BASE()}assets/chars/${name}.png` : `${BASE()}assets/${name}.png`

/**
 * A missing sprite resolves rather than rejects: one absent PNG should leave a
 * hole in the scene, not stop the office from rendering at all.
 */
const loadImage = (name) =>
  new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve([name, image])
    image.onerror = () => {
      console.warn('office: missing sprite', spritePath(name))
      resolve([name, null])
    }
    image.src = spritePath(name)
  })

/** @returns {Promise<Record<string, HTMLImageElement>>} name → loaded image */
export async function loadSprites() {
  const loaded = await Promise.all([...TILES, ...CHARACTER_SPRITES].map(loadImage))
  return Object.fromEntries(loaded.filter(([, image]) => image))
}

/** The map, from the same static directory. */
export async function loadMap() {
  const response = await fetch(`${BASE()}office.json`, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`Could not load the office map (HTTP ${response.status})`)

  const map = await response.json()
  if (!map?.cols || !map?.rows) throw new Error('The office map is malformed.')
  return map
}
