// Wrapper around fake-server.mjs that records its own pid, so a repro can check which
// server processes are still alive on any platform.
// Usage: node pid-server.mjs <pid-file> <mode> <log-file>
import { appendFileSync } from 'node:fs'

const [pidFile, mode, logFile] = process.argv.slice(2)
appendFileSync(pidFile, `${process.pid}\n`)
// Record the native pipe the server was launched with, so the reconnect test can tell
// a reused process from a new one started from the rewritten .mcp.json.
if (logFile !== undefined) {
  appendFileSync(logFile, `server-env ${process.env.SKY_CUA_NATIVE_PIPE_DIRECTORY ?? '-'}\n`)
}
process.argv = [process.argv[0], 'fake-server.mjs', mode, logFile]
await import('./fake-server.mjs')
