// Fake cua_repl server that records its pid and the CUA_REPL_ENABLED_SURFACES value it
// was spawned with, then answers initialize and tools/call like the `ok` fake server.
// Usage: node fake-surface-server.mjs <pid-file> <surfaces-file> <log-file>
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const [pidFile, surfacesFile, logFile] = process.argv.slice(2)
appendFileSync(pidFile, `${process.pid}\n`)
const surfaces = process.env.CUA_REPL_ENABLED_SURFACES
appendFileSync(surfacesFile, `${surfaces === undefined ? '<unset>' : surfaces}\n`)

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function record(text) {
  appendFileSync(logFile, `${text}\n`)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) return
  record(message.method)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fake-surface' },
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ran js' }] },
    })
  }
})
