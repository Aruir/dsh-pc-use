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
