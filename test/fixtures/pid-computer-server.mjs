// Wrapper around fake-computer-server.mjs that records its own pid, so tests can assert
// every server they started has exited.
// Usage: node pid-computer-server.mjs <pid-file> <mode> <log-file>
import { appendFileSync } from 'node:fs'

const [pidFile, ...rest] = process.argv.slice(2)
appendFileSync(pidFile, `${process.pid}\n`)
process.argv = [process.argv[0], 'fake-computer-server.mjs', ...rest]
await import('../fake-computer-server.mjs')
