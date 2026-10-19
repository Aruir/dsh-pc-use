// r18: decodeImage accepts canonical MCP image blocks and rejects non-canonical base64.
// The canonical check compares the round-trip of the last group instead of the whole string.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeImage } from '../lib/image-projection.js'

const BAD_BASE64 = 'the image data is not canonical base64'
const BAD_MEDIA = 'the declared media type is not PNG, JPEG, WebP, or GIF'

/** One image block with a valid media type. O(1). */
function block(data) {
  return { mimeType: 'image/png', data }
}

test('canonical base64 decodes to the original bytes', () => {
  // 300 bytes is a multiple of 3, so the encoded length is a multiple of 4 with no padding.
  const random = Buffer.alloc(300)
  for (let index = 0; index < random.length; index += 1) {
    random[index] = (index * 37) % 256
  }
  const encoded = random.toString('base64')
  const cases = [
    ['', Buffer.alloc(0)],
    ['QQ==', Buffer.from('A')],
    ['QUJD', Buffer.from('ABC')],
    ['QUI=', Buffer.from('AB')],
    [encoded, random],
  ]
  for (const [data, expected] of cases) {
    const decoded = decodeImage(block(data))
    assert.equal(decoded.mediaType, 'image/png')
    assert.deepEqual(decoded.data, expected)
  }
})

test('non-canonical base64 is rejected with the same error', () => {
  // 'QR==' and 'QUJ=' decode but re-encode their last group differently; 'QQ' is not
  // 4-character aligned; 'QQ=A' has '=' before the end; a space is outside the alphabet.
  for (const data of ['QR==', 'QUJ=', 'QQ', 'QQ=A', 'QU JD']) {
    assert.throws(() => decodeImage(block(data)), { message: BAD_BASE64 }, data)
  }
})

test('unsupported media types keep the original error', () => {
  assert.throws(
    () => decodeImage({ mimeType: 'image/bmp', data: 'QQ==' }),
    { message: BAD_MEDIA },
  )
  assert.throws(
    () => decodeImage({ mimeType: undefined, data: 'QQ==' }),
    { message: BAD_MEDIA },
  )
})
