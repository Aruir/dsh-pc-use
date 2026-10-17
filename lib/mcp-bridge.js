// A deliberately small MCP stdio client for Codex's `cua_repl` server.
//
// It does the three things Codex's own client does and a vanilla MCP client does not:
//   1. `initialize` advertises form-elicitation capability (needed for approvals)
//   2. every `tools/call` carries `_meta["x-codex-turn-metadata"]`
//   3. server-initiated `elicitation/create` approval requests are answered locally

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

const DEFAULT_TIMEOUT_MS = 120_000

export class McpBridge {
  constructor({ command, args, env, cwd, sessionId, autoApprove = true, log = () => {} }) {
    this.command = command
    this.args = args ?? []
    this.env = env
    this.cwd = cwd
    this.sessionId = sessionId
    this.turnId = `turn-${randomUUID()}`
    this.autoApprove = autoApprove
    this.log = log
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.starting = null
    this.stderrTail = []
  }

  get alive() {
    return this.child !== null && this.child.exitCode === null && this.child.killed === false
  }

  async start() {
    if (this.alive && this.starting !== null) return this.starting
    if (this.alive) return
    this.starting = this.#spawnAndHandshake().catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  #spawnAndHandshake() {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env,
          windowsHide: true,
        })
      } catch (error) {
        reject(new Error(`spawn failed: ${error.message}`))
        return
      }
      this.child = child
      this.stderrTail = []

      child.on('error', (error) => {
        this.#failAll(new Error(`Codex computer-use server error: ${error.message}`))
        reject(error)
      })
      child.on('exit', (code) => {
        this.child = null
        this.starting = null
        this.#failAll(new Error(`Codex computer-use server exited (code ${code})${this.#stderrSuffix()}`))
      })
      child.stderr.on('data', (chunk) => {
        const text = String(chunk)
        this.log(`stderr ${text.trim()}`)
        this.stderrTail.push(text)
        if (this.stderrTail.length > 20) this.stderrTail.shift()
      })
      readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
        .on('line', (line) => this.#onLine(line))

      const init = {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: 'dsh-codex-cu', version: '0.1.0' },
        },
      }
      this.#write(init)
      this.pending.set(init.id, {
        resolve: (result) => {
          this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' })
          resolve(result)
        },
        reject,
        timer: setTimeout(() => {
          this.pending.delete(init.id)
          reject(new Error(`initialize timed out${this.#stderrSuffix()}`))
        }, 30_000),
      })
    })
  }

  #stderrSuffix() {
    const tail = this.stderrTail.join('').trim()
    return tail === '' ? '' : `: ${tail.slice(-600)}`
  }

  #write(message) {
    if (this.child === null || this.child.stdin.destroyed) throw new Error('Codex computer-use server is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  #onLine(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`unparsed server output: ${line.slice(0, 200)}`)
      return
    }

    // Server-initiated request: answer approvals here, decline to invent others.
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
      if (message.method === 'elicitation/create') {
        const question = message.params?.message ?? JSON.stringify(message.params ?? {})
        const action = this.autoApprove ? 'accept' : 'decline'
        this.log(`approval ${JSON.stringify(question)} -> ${action}`)
        this.#write({ jsonrpc: '2.0', id: message.id, result: { action, content: {} } })
        return
      }
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `method not supported by dsh-codex-cu: ${message.method}` },
      })
      return
    }

    // Responses.
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
    } else {
      entry.resolve(message.result)
    }
  }

  /** Call an MCP tool and return its raw result. */
  async call(name, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.start()
    const id = this.nextId++
    const request = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name,
        arguments: args ?? {},
        _meta: {
          'x-codex-turn-metadata': { session_id: this.sessionId, turn_id: this.turnId },
        },
      },
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${name} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.#write(request)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  stop() {
    this.#failAll(new Error('Codex computer-use bridge stopped'))
    if (this.child !== null) {
      try {
        this.child.stdin.end()
      } catch {}
      try {
        this.child.kill()
      } catch {}
      this.child = null
    }
    this.starting = null
  }
}
