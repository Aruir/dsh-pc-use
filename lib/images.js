// Screenshots are written to disk so the model can reach them, but the directory is
// pruned after every save so it cannot grow without bound.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export const MAX_IMAGES = 50

/** File extension for an image mime type; anything unknown is saved as `.bin`. */
export function imageExtension(mimeType) {
  return EXTENSIONS[mimeType] ?? 'bin'
}

// O(n log n), n = files in the directory: one readdir, one stat per file, one sort.
/** Delete every regular file in `directory` except the newest `keep`. */
export function pruneImages(directory, keep = MAX_IMAGES) {
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  const files = []
  for (const name of names) {
    const file = join(directory, name)
    try {
      const stat = statSync(file)
      if (stat.isFile()) files.push({ file, mtimeMs: stat.mtimeMs })
    } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const entry of files.slice(keep)) {
    try {
      rmSync(entry.file, { force: true })
    } catch {}
  }
}

/** Save one base64 image, prune the directory, and return the saved path. */
export function saveImage(image, directory) {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${randomUUID()}.${imageExtension(image.mimeType)}`)
  writeFileSync(file, Buffer.from(image.data, 'base64'))
  pruneImages(directory)
  return file
}
