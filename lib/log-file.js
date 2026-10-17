// The bridge log has no external rotation, so keep exactly one old file: a long-running
// DSH session with a chatty Codex server must not fill the disk.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_LOG_BYTES = 1024 * 1024

/** Rotate `file` to `file.1` once it exceeds `maxBytes`. O(1): one stat, one rename. */
export function rotateLogFile(file, maxBytes = MAX_LOG_BYTES) {
  let size
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size <= maxBytes) return
  try {
    rmSync(`${file}.1`, { force: true })
  } catch {}
  try {
    renameSync(file, `${file}.1`)
  } catch {}
}

/** Append one log line, rotating first. O(1) per line: one stat and one append. */
export function appendLogLine(file, line, maxBytes = MAX_LOG_BYTES) {
  mkdirSync(dirname(file), { recursive: true })
  rotateLogFile(file, maxBytes)
  appendFileSync(file, line)
}
