// I: run the test suite under a private temp directory and fail if it left any of the known
// temp-dir prefixes behind inside it. The check counts only; it deletes only the directory it
// created for this run, never directories it did not create.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIXES = ['pc-use-', 'dsh-pc-use-', 'pc-use-test-']
// A run-private TEMP/TMP keeps concurrent runs from seeing each other's directories.
const runDir = mkdtempSync(join(tmpdir(), 'pc-use-run-'))

function leftoverDirs() {
  const names = []
  for (const name of readdirSync(runDir)) {
    if (PREFIXES.some((prefix) => name.startsWith(prefix))) names.push(name)
  }
  return names.sort()
}

const result = spawnSync(
  process.execPath,
  ['--test', 'test/*.test.mjs', 'test/schema.mjs'],
  {
    stdio: 'inherit',
    env: { ...process.env, TEMP: runDir, TMP: runDir, TMPDIR: runDir },
  },
)
const leaked = leftoverDirs()
if (leaked.length > 0) {
  console.error(`\nLeftover test temp directories (${leaked.length}):`)
  for (const name of leaked) console.error(`  ${name}`)
  console.error(`runDir: ${runDir}`)
  process.exitCode = 1
} else {
  // This directory belongs to this run, so it is safe to delete; it may hold node's cache.
  rmSync(runDir, { recursive: true, force: true })
}
if (result.error !== undefined) {
  console.error(result.error)
  process.exitCode = 1
} else if (result.status !== 0) {
  process.exitCode = result.status
}
