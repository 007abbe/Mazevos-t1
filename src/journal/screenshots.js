/**
 * Chart screenshots.
 *
 * Storage format is unchanged from FlowJournal: a base64 data URI written
 * straight into the `trades.image` text column (trading-journal/index.html:1972
 * reads the file with FileReader.readAsDataURL and stores the result verbatim).
 * Keeping that format means FlowJournal renders Mazevo's screenshots and vice
 * versa, with no schema change and no backfill.
 *
 * What changes is size. FlowJournal stores the file exactly as dropped —
 * a 1 MB PNG becomes ~1.37 MB of base64 inside the row. Here the image is
 * downscaled and re-encoded to JPEG first, which typically lands the same
 * screenshot in 100-200 KB.
 *
 * Moving `image` to Supabase Storage is the better end state, deliberately
 * deferred: it changes the column's meaning and needs a production backfill
 * plus a lockstep FlowJournal update.
 */

/** Longest edge, in pixels, after downscaling. Chart detail survives this. */
export const MAX_DIMENSION = 1600

/** Target for the encoded data URI. Rows stay small enough to send freely. */
export const MAX_BYTES = 400_000

/** Quality/size ladder, tried in order until one lands under MAX_BYTES. */
const LADDER = [
  { maxDim: MAX_DIMENSION, quality: 0.85 },
  { maxDim: MAX_DIMENSION, quality: 0.7 },
  { maxDim: 1280, quality: 0.7 },
  { maxDim: 1024, quality: 0.65 },
  { maxDim: 800, quality: 0.6 },
]

/** Scales `w`x`h` down to fit `maxDim` on its longest edge. Never scales up. */
export function fitDimensions(w, h, maxDim = MAX_DIMENSION) {
  if (!(w > 0) || !(h > 0)) throw new RangeError(`Invalid image size ${w}x${h}`)
  const scale = Math.min(1, maxDim / Math.max(w, h))
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

/** Decoded byte length of a data URI's payload — what actually hits the column. */
export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  if (!base64) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export function isImageFile(file) {
  return Boolean(file) && typeof file.type === 'string' && file.type.startsWith('image/')
}

function toJpegDataUrl(bitmap, { maxDim, quality }) {
  const { width, height } = fitDimensions(bitmap.width, bitmap.height, maxDim)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  // JPEG has no alpha. Without this, transparent PNG regions encode as black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)

  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * Reads an image File (from a file input, drag-drop, or a clipboard paste) and
 * returns a compressed JPEG data URI ready to store in `trades.image`.
 *
 * Walks the quality ladder until the result fits MAX_BYTES; if even the last
 * rung is over, returns it anyway rather than losing the screenshot.
 */
export async function compressImage(file, { maxBytes = MAX_BYTES } = {}) {
  if (!isImageFile(file)) throw new TypeError('Not an image file')

  const bitmap = await createImageBitmap(file)
  try {
    let result = ''
    for (const rung of LADDER) {
      result = toJpegDataUrl(bitmap, rung)
      if (dataUrlBytes(result) <= maxBytes) return result
    }
    return result
  } finally {
    bitmap.close?.()
  }
}
