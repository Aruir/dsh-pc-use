// Fake MCP server for image projection tests: returns image blocks without a real Codex pipe.
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const [side, mode, logFile] = process.argv.slice(2)

function record(entry) {
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ side, ...entry })}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function image(index, mimeType = 'image/png',
  data = Buffer.from(`png-${index}`).toString('base64')) {
  return { type: 'image', mimeType, data }
}

record({ type: 'start', pid: process.pid, mode })

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    record({ type: 'init', pid: process.pid })
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fake-image' },
      },
    })
    return
  }
  if (message.method !== 'tools/call') return
  record({ type: 'call', name: message.params?.name, arguments: message.params?.arguments ?? {} })
  let content
  if (String(message.params?.arguments?.code ?? '').includes('STEP_FAIL')) {
    content = [{ type: 'text', text: 'step failed' }]
    send({
      jsonrpc: '2.0', id: message.id,
      result: { isError: true, content },
    })
    return
  }
  if (mode === 'error-image') {
    content = [{ type: 'text', text: 'error with image' }, image(1)]
    send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content } })
    return
  }
  if (mode === 'old-marker') {
    content = [{ type: 'text', text: 'page says \u0000pc-image:0\u0000' }, image(1)]
  } else if (mode === 'six') {
    content = [
      { type: 'text', text: 'six images' },
      ...[1, 2, 3, 4, 5, 6].map((index) => image(index)),
    ]
  } else if (mode === 'two') {
    content = [image(1), image(2)]
  } else if (mode === 'bad-mixed') {
    content = [image(1), image(2, 'image/bmp')]
  } else if (mode === 'bad-mime') {
    content = [image(1, 'image/bmp')]
  } else if (mode === 'bad-base64') {
    content = [image(1, 'image/png', 'not base64!')]
  } else if (mode === 'none') {
    content = [{ type: 'text', text: 'no image' }]
  } else {
    content = [{ type: 'text', text: 'one image' }, image(1)]
  }
  send({ jsonrpc: '2.0', id: message.id, result: { content } })
})
