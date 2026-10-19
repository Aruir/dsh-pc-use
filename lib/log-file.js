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

/**
 * Append one log line, rotating first. Normally one stat and one append; only a failed append
 * creates the directory and retries. O(1) plus the retry path.
 */
export function appendLogLine(file, line, maxBytes = MAX_LOG_BYTES) {
  rotateLogFile(file, maxBytes)
  try {
    appendFileSync(file, line)
  } catch {
    // The directory may not exist yet (first line, or it was removed); create it and retry
    // once. Any other failure repeats on the retry and is thrown from there.
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line)
  }
}

/**
 * Check that the log directory can be established and `file` can be appended to,
 * for `pc_status.log.writable`. An empty append proves write access without
 * rotating, truncating or reading existing content. Never throws: any fs failure
 * means "not writable". O(1): one recursive mkdir and one append syscall.
 */
export function checkLogWritable(file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, '')
    return true
  } catch {
    return false
  }
}
