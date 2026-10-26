// r25: documentation the Codex MCP servers publish for their own tools. `initialize` returns
// the namespace instructions and `tools/list` returns the `js` family descriptions. The plugin
// caches them so it can register accurate descriptions before starting any server.
//
// The cache stores documentation text and hashes only. It must never contain a command, an
// argument, an environment value, a working directory or the volatile native pipe name.

import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const CACHE_VERSION = 1
const MAX_CACHE_BYTES = 256 * 1024
const MAX_STRING_BYTES = 64 * 1024
const HASH_PATTERN = /^[0-9a-f]{64}$/
const OPTIONAL_TOOL_KEYS = ['js_reset', 'js_add_node_module_dir']
const TOOL_KEYS = ['js', ...OPTIONAL_TOOL_KEYS]

/** True for a non-array object, the only shape the cache accepts for containers. O(1). */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** True for a string with at least one character. O(1). */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/** True for a string of at most 64 KiB of UTF-8, the per-string cache limit. O(bytes). */
function isBoundedString(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES
}

/** True for a non-empty string of at most 64 KiB of UTF-8. O(bytes). */
function isCachedText(value) {
  return isNonEmptyString(value) && isBoundedString(value)
}

/** True for a lowercase 64-character SHA-256 hex digest. O(1). */
function isHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value)
}

/** Locale-independent name order, so one tool list hashes the same on every machine. O(1). */
function compareNames(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** SHA-256 hex digest of one text. O(text size). */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Serialize a JSON value with object keys sorted recursively, array order kept and every other
 * value serialized like JSON.stringify. Undefined object values are dropped and undefined array
 * items become null, matching JSON's own rules. O(n log n) time, n = values in the tree, because
 * each object's keys are sorted once; O(n) space for the text.
 */
function canonicalValue(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalValue(item === undefined ? null : item))
    return `[${items.join(',')}]`
  }
  if (isObject(value)) {
    const parts = []
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      parts.push(`${JSON.stringify(key)}:${canonicalValue(value[key])}`)
    }
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Canonical JSON text: object keys sorted recursively and array order kept. It is the stable
 * hash input for fingerprints and docs hashes. O(n log n) time, n = values in the tree, because
 * each object's keys are sorted once.
 */
export function canonicalJson(value) {
  return canonicalValue(value)
}

/**
 * SHA-256 of a launch spec's identity: `command`, `args`, `source`, `surfaces` and the command
 * file's size and mtime. `surfaces` is included because the server's `js` description differs
 * with the capability surfaces. The rest of `env`, `cwd` and `pipeDirectory` are deliberately
 * excluded: env can hold secrets and the native pipe name changes on every Codex start, so
 * neither may make a valid cache look stale. A failed `statSync` records both file fields as
 * null so the fingerprint still exists. O(stat + n) time, n = size of `args` and of the
 * canonical text.
 */
export function specFingerprint(spec) {
  const parsed = isObject(spec) ? spec : {}
  const command = typeof parsed.command === 'string' ? parsed.command : null
  const args = Array.isArray(parsed.args) ? parsed.args : []
  const source = typeof parsed.source === 'string' ? parsed.source : null
  const surfaces = typeof parsed.surfaces === 'string' ? parsed.surfaces : null
  let commandSize = null
  let commandMtimeMs = null
  if (command !== null) {
    try {
      const stat = statSync(command)
      commandSize = stat.size
      commandMtimeMs = stat.mtimeMs
    } catch {}
  }
  return sha256(canonicalJson({
    command, args, source, surfaces, commandSize, commandMtimeMs,
  }))
}

/**
 * Build one target's docs from an `initialize` result and a fully merged `tools/list` array.
 * Only descriptions of the `js` family are kept; a missing or empty `js` description returns
 * null because there is then nothing to cache or resend. `docsHash` covers exactly the docs
 * that compose into tool descriptions; `listHash` covers the whole tool list and is only shown
 * by pc_status. Tool order does not matter: both hashes sort their input. O(t log t + d),
 * t = tools, d = description text.
 */
export function docsFromServer({ instructions, tools } = {}) {
  const list = Array.isArray(tools) ? tools.filter(isObject) : []
  const docs = {}
  for (const tool of list) {
    if (typeof tool.name !== 'string' || !TOOL_KEYS.includes(tool.name)) continue
    if (!isNonEmptyString(tool.description) || docs[tool.name] !== undefined) continue
    docs[tool.name] = tool.description
  }
  if (docs.js === undefined) return null
  const normalizedInstructions = isNonEmptyString(instructions) ? instructions : null
  const sorted = list
    .map((tool) => ({
      name: typeof tool.name === 'string' ? tool.name : '',
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
    .sort((left, right) => compareNames(left.name, right.name))
  const toolNames = sorted
    .map((tool) => tool.name)
    .filter((name) => name !== '')
    .sort()
  return {
    instructions: normalizedInstructions,
    tools: docs,
    docsHash: sha256(canonicalJson({ instructions: normalizedInstructions, tools: docs })),
    listHash: sha256(canonicalJson(sorted)),
    toolNames,
  }
}

/**
 * Validate one target's cached entry; null when any field or the recomputed docs hash is wrong.
 * The hash is recomputed from the stored docs instead of trusted, so a corrupted or hand-edited
 * entry can never put wrong text into a tool description. O(d log d), d = docs text.
 */
function readCacheEntry(raw) {
  if (!isObject(raw)) return null
  if (!isHash(raw.fingerprint) || !isHash(raw.docsHash) || !isHash(raw.listHash)) return null
  if (raw.instructions !== null && !isBoundedString(raw.instructions)) return null
  if (!isObject(raw.tools) || !isCachedText(raw.tools.js)) return null
  const tools = { js: raw.tools.js }
  for (const key of OPTIONAL_TOOL_KEYS) {
    const value = raw.tools[key]
    if (value === undefined) continue
    if (!isCachedText(value)) return null
    tools[key] = value
  }
  if (!Array.isArray(raw.toolNames) || !raw.toolNames.every(isBoundedString)) return null
  if (!isBoundedString(raw.fetchedAt)) return null
  const docsHash = sha256(canonicalJson({ instructions: raw.instructions, tools }))
  if (docsHash !== raw.docsHash) return null
  return {
    fingerprint: raw.fingerprint,
    instructions: raw.instructions,
    tools,
    docsHash: raw.docsHash,
    listHash: raw.listHash,
    toolNames: [...raw.toolNames],
    fetchedAt: raw.fetchedAt,
  }
}

/**
 * Read the cache file and return `{ browser, desktop }`, each a validated entry or null. Every
 * failure is silent: a missing, unreadable or oversized file, invalid JSON, a wrong top-level
 * version or an invalid entry only nulls the affected values, because a bad cache must never
 * stop the plugin from starting or fall back to text from another Codex install. O(f + d log d),
 * f = file bytes, d = docs text.
 */
export function readDocsCache(file) {
  let raw
  try {
    const stat = statSync(file)
    if (stat.size > MAX_CACHE_BYTES) return { browser: null, desktop: null }
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { browser: null, desktop: null }
  }
  if (!isObject(raw) || raw.version !== CACHE_VERSION) {
    return { browser: null, desktop: null }
  }
  return { browser: readCacheEntry(raw.browser), desktop: readCacheEntry(raw.desktop) }
}

/**
 * Replace one target's cache entry while keeping the other target's valid entry. The new text
 * goes to `<file>.<pid>.<random>.tmp` in the same directory and is renamed over the cache, so a
 * crash never leaves a half-written cache. Two concurrent DSH writers may lose the older entry,
 * but the next server connection rewrites it; no lock is added. Every failure returns
 * `{ ok: false, reason }` with a reason that never contains command, args or env values, removes
 * the temp file and never throws. `fsOps` is an optional test seam: it supplies the fs
 * functions to use (default `node:fs`), so a test can record the temp-file + rename order.
 * O(f + n), f = cache bytes, n = entry size, plus file I/O.
 */
export function writeDocsCacheEntry(file, target, entry, fsOps = {}) {
  if (target !== 'browser' && target !== 'desktop') {
    return { ok: false, reason: 'invalid target' }
  }
  const ops = {
    mkdirSync: fsOps.mkdirSync ?? mkdirSync,
    writeFileSync: fsOps.writeFileSync ?? writeFileSync,
    renameSync: fsOps.renameSync ?? renameSync,
    unlinkSync: fsOps.unlinkSync ?? unlinkSync,
  }
  const cached = readDocsCache(file)
  cached[target] = entry
  let tempFile = null
  try {
    ops.mkdirSync(dirname(file), { recursive: true })
    const data = { version: CACHE_VERSION, browser: cached.browser, desktop: cached.desktop }
    tempFile = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    ops.writeFileSync(tempFile, JSON.stringify(data), 'utf8')
    ops.renameSync(tempFile, file)
    tempFile = null
    return { ok: true }
  } catch (error) {
    if (tempFile !== null) {
      try {
        ops.unlinkSync(tempFile)
      } catch {}
    }
    const detail = typeof error?.code === 'string' ? error.code : 'unknown error'
    return { ok: false, reason: `cache write failed: ${detail}` }
  }
}

/**
 * Join a server's docs into one tool description. `js` gets the namespace instructions when
 * present, its own description and the appendix; the reset tools get their description and the
 * appendix. A missing tool description returns null so the caller keeps the built-in text. An
 * empty appendix stays as the last segment; callers that resend plain docs strip it.
 * O(d), d = docs text.
 */
export function composeDescription(server, toolKey, appendix) {
  const tools = isObject(server) ? server.tools : null
  const description = isObject(tools) ? tools[toolKey] : undefined
  if (!isNonEmptyString(description)) return null
  const parts = []
  if (toolKey === 'js' && isNonEmptyString(server.instructions)) parts.push(server.instructions)
  parts.push(description)
  parts.push(typeof appendix === 'string' ? appendix : '')
  return parts.join('\n\n')
}
