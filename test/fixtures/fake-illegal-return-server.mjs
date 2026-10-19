// Fake MCP server that rejects a js call with Codex's top-level `return` parser error.
// Any other call returns a normal text result. Used only by the tool-result guidance tests.
import readline from 'node:readline'

import { tabGuardSource } from '../../lib/tab-guard.js'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake' } },
    })
    return
  }
  if (message.method !== 'tools/call') return
  const fullCode = String(message.params?.arguments?.code ?? '')
  const guard = `${tabGuardSource()}\n`
  const code = fullCode.startsWith(guard) ? fullCode.slice(guard.length) : fullCode
  if (code.includes('return')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Illegal return statement' }],
      },
    })
    return
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { content: [{ type: 'text', text: `ran ${message.params?.name ?? 'js'}` }] },
  })
})
