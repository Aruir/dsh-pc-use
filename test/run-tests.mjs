// I: run the test suite and fail if it left any of the known temp-dir prefixes behind.
// This check counts only; it never deletes directories it did not create.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const PREFIXES = ['pc-use-', 'dsh-pc-use-', 'pc-use-test-']

function temporaryDirs() {
  const names = []
  for (const name of readdirSync(tmpdir())) {
    if (PREFIXES.some((prefix) => name.startsWith(prefix))) names.push(name)
  }
  return new Set(names)
}

const before = temporaryDirs()
const result = spawnSync(
  process.execPath,
  ['--test', 'test/*.test.mjs', 'test/schema.mjs'],
  { stdio: 'inherit' },
)
const after = temporaryDirs()
const leaked = [...after].filter((name) => !before.has(name)).sort()
if (leaked.length > 0) {
  console.error(`\nLeftover test temp directories (${leaked.length}):`)
  for (const name of leaked) console.error(`  ${name}`)
  process.exitCode = 1
}
if (result.error !== undefined) {
  console.error(result.error)
  process.exitCode = 1
} else if (result.status !== 0) {
  process.exitCode = result.status
}
