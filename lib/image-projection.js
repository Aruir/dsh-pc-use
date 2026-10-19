// Image projection for Codex tool results: decide whether raw MCP image blocks can be
// attached, save fallbacks, and build the text placeholders the tool value must carry.
// The DSH mcp-client does this inside its executor; this plugin owns the same policy.

export const MAX_ATTACHED_IMAGES = 4

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** True when one content array declares an image block. O(n), n = content length. */
export function containsImage(content) {
  return Array.isArray(content) && content.some((block) => (
    typeof block === 'object' && block !== null && block.type === 'image'
  ))
}

/** Decode one canonical MCP image block; throws on unsupported type or bad base64. O(n). */
export function decodeImage(block) {
  if (!IMAGE_MEDIA_TYPES.includes(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new Error('the image data is not canonical base64')
  }
  return { data, mediaType: block.mimeType }
}

/** Read one optional context service without letting a service getter throw. O(1). */
function readService(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Resolve the current route and attachment store, mirroring dsh-mcp-client. O(1). */
async function resolveAdmission(ctx, exec) {
  if (typeof exec !== 'object' || exec === null) {
    throw new Error('the current model route could not be resolved')
  }
  const attachments = readService(ctx, 'attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  let routed
  try {
    routed = exec.agent?.session?.requestHeader?.()?.config
  } catch {
    throw new Error('the current model route could not be resolved')
  }
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = readService(ctx, 'llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('the current model route could not be resolved')
  }
  if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal?.aborted === true) throw new Error('the tool call was canceled')
  return attachments
}

/** Keep the old path text for one image that cannot be attached. O(1). */
function fallbackPlaceholder(image, index, reason, saveLocal) {
  let saved
  try {
    saved = saveLocal(image)
  } catch {
    saved = null
  }
  const path = saved === null ? '[image could not be saved]' : `[image saved: ${saved}]`
  return `${path}\n[image ${index + 1} not attached: ${reason}]`
}

/** Save every image as a fallback path and return all placeholders. O(images). */
export function fallbackPlaceholders(images, saveLocal, reason) {
  return {
    placeholders: images.map((image, index) => (
      fallbackPlaceholder(image, index, reason, saveLocal)
    )),
    refs: images.map(() => null),
  }
}

/**
 * Decide and prepare one batch. Returns placeholders aligned with `images` and the
 * attachment refs to project (null for every image that could not be attached).
 * O(images) apart from attachment writes; one fallback log line per refused batch.
 */
export async function prepareImageProjection({
  ctx, exec, images, attachImages, keepImageFiles, saveLocal, log = () => {},
}) {
  if (attachImages !== true) {
    log('image projection fallback: attachImages is off')
    return fallbackPlaceholders(images, saveLocal, 'attachImages is off')
  }
  let decoded
  try {
    decoded = images.map(decodeImage)
  } catch {
    log('image projection fallback: unsupported image data')
    return fallbackPlaceholders(images, saveLocal, 'unsupported image data')
  }
  let attachments
  try {
    attachments = await resolveAdmission(ctx, exec)
  } catch (error) {
    const reason = error.message === 'no attachment store is mounted'
      ? 'no attachment store'
      : error.message.includes('does not declare image input')
        ? 'model has no image input'
        : error.message === 'the tool call was canceled'
          ? 'call canceled'
          : 'model route unknown'
    log(`image projection fallback: ${reason}`)
    return fallbackPlaceholders(images, saveLocal, reason)
  }
  const firstAttached = Math.max(0, images.length - MAX_ATTACHED_IMAGES)
  let refs
  try {
    refs = await attachments.saveImages(decoded.slice(firstAttached))
  } catch {
    log('image projection fallback: attachment store rejected the images')
    return fallbackPlaceholders(images, saveLocal, 'attachment store rejected the images')
  }
  const placeholders = []
  const alignedRefs = []
  for (let index = 0; index < images.length; index += 1) {
    if (index < firstAttached) {
      placeholders.push(fallbackPlaceholder(
        images[index], index, 'more than 4 images in one result', saveLocal,
      ))
      alignedRefs.push(null)
      continue
    }
    const ref = refs[index - firstAttached]
    const mimeType = images[index].mimeType
    if (keepImageFiles === true) {
      try {
        const saved = saveLocal(images[index])
        placeholders.push(`[image ${index + 1}: ${mimeType}, attached; saved: ${saved}]`)
      } catch {
        placeholders.push(`[image ${index + 1}: ${mimeType}, attached; could not be saved]`)
      }
    } else {
      placeholders.push(`[image ${index + 1}: ${mimeType}, attached]`)
    }
    alignedRefs.push(ref)
  }
  return { placeholders, refs: alignedRefs }
}
