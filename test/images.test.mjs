// F6: screenshots are saved with a mime-derived extension and the directory keeps only
// the newest 50 files.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { imageExtension, MAX_IMAGES, pruneImages, saveImage } from '../lib/images.js'
import { tempDir } from './helpers.mjs'

function writeDated(directory, name, seconds) {
  const file = join(directory, name)
  writeFileSync(file, 'x')
  const stamp = new Date(2026, 0, 1, 0, 0, seconds)
  utimesSync(file, stamp, stamp)
  return file
}

test('image extensions follow the mime type and fall back to bin', () => {
  assert.equal(imageExtension('image/png'), 'png')
  assert.equal(imageExtension('image/jpeg'), 'jpg')
  assert.equal(imageExtension('image/webp'), 'webp')
  assert.equal(imageExtension('image/gif'), 'gif')
  assert.equal(imageExtension('image/bmp'), 'bin')
  assert.equal(imageExtension(undefined), 'bin')
})

test('saveImage writes the right extension and keeps only the newest 50 files', () => {
  const directory = tempDir()
  for (let index = 0; index < 55; index += 1) {
    writeDated(directory, `old-${index}.png`, index)
  }
  const saved = saveImage(
    { data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' },
    directory,
  )
  assert.match(saved, /\.png$/)
  assert.equal(existsSync(saved), true)
  const kept = readdirSync(directory)
  assert.equal(kept.length, MAX_IMAGES)
  assert.equal(kept.includes('old-0.png'), false)
  assert.equal(kept.includes('old-5.png'), false)
  assert.equal(kept.includes('old-6.png'), true)
  assert.equal(kept.includes('old-54.png'), true)
})

test('pruneImages keeps the requested number of newest files', () => {
  const directory = tempDir()
  writeDated(directory, 'a.png', 1)
  writeDated(directory, 'b.png', 2)
  writeDated(directory, 'c.png', 3)
  pruneImages(directory, 2)
  assert.deepEqual(readdirSync(directory).sort(), ['b.png', 'c.png'])
})

test('saveImage uses .bin for an unknown mime type', () => {
  const directory = tempDir()
  const saved = saveImage(
    { data: Buffer.from('x').toString('base64'), mimeType: 'image/bmp' },
    directory,
  )
  assert.match(saved, /\.bin$/)
})
