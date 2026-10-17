// A deliberately small MCP stdio client for Codex's `cua_repl` server.
//
// It does the three things Codex's own client does and a vanilla MCP client does not:
//   1. `initialize` advertises form-elicitation capability (needed for approvals)
//   2. every `tools/call` carries `_meta["x-codex-turn-metadata"]`
//   3. server-initiated `elicitation/create` approval requests are answered locally

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import readline from 'node:readline'

import { decideApproval } from './approval.js'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_INIT_TIMEOUT_MS = 30_000

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Client version advertised to the MCP server; always the package version. */
export const clientVersion = packageJson.version

export class McpBridge {
  constructor({
    command, args, env, cwd, sessionId, shouldApprove = () => false,
    initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS, log = () => {},
  }) {
    this.command = command
    this.args = args ?? []
    this.env = env
    this.cwd = cwd
    this.sessionId = sessionId
    this.turnId = `turn-${randomUUID()}`
    this.shouldApprove = shouldApprove
    this.initTimeoutMs = initTimeoutMs
    this.log = log
    this.child = null
    this.ready = false
    this.pending = new Map()
    this.nextId = 1
    this.starting = null
    this.stderrTail = []
  }

  get alive() {
    if (this.ready !== true || this.child === null) return false
    return this.child.exitCode === null && this.child.killed === false
  }

  async start() {
    if (this.starting !== null) return this.starting
    if (this.alive) return
    this.starting = this.#spawnAndHandshake().catch((error) => {
      this.#discardChild()
      this.starting = null
      throw error
    })
    return this.starting
  }

  /** Kill and forget the child; a live handshake rejects through `#failAll`/`exit`. */
  #discardChild() {
    this.ready = false
    const child = this.child
    this.child = null
    this.starting = null
    if (child === null) return
    try {
      child.stdin.end()
    } catch {}
    try {
      child.kill()
    } catch {}
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
      this.ready = false
      this.stderrTail = []

      child.on('error', (error) => {
        if (this.child !== child) return
        this.#failAll(new Error(`Codex computer-use server error: ${error.message}`))
        this.#discardChild()
        reject(error)
      })
      child.on('exit', (code) => {
        // A child discarded by `#discardChild` is no longer the current one; its late
        // exit must not fail the handshake of a replacement child.
        if (this.child !== child) return
        this.ready = false
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
      // A dead child makes `stdin.write` fail asynchronously; log it instead of letting
      // the unhandled 'error' event take the host process down.
      child.stdin.on('error', (error) => {
        this.log(`stdin error: ${error.message}`)
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
          clientInfo: { name: 'dsh-codex-cu', version: clientVersion },
        },
      }
      const entry = {
        resolve: (result) => {
          try {
            this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' })
          } catch (error) {
            reject(error)
            return
          }
          this.ready = true
          resolve(result)
        },
        reject,
        timer: setTimeout(() => {
          this.pending.delete(init.id)
          const error = new Error(
            `initialize timed out after ${this.initTimeoutMs}ms${this.#stderrSuffix()}`,
          )
          this.#discardChild()
          reject(error)
        }, this.initTimeoutMs),
      }
      this.pending.set(init.id, entry)
      try {
        this.#write(init)
      } catch (error) {
        this.pending.delete(init.id)
        clearTimeout(entry.timer)
        this.#discardChild()
        reject(error)
      }
    })
  }

  /** Tell the server the client gave up, so the running code can be cancelled. */
  #cancel(requestId, reason) {
    try {
      this.#write({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId, reason },
      })
    } catch (error) {
      this.log(`cancel notification failed: ${error.message}`)
    }
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
        const decision = decideApproval(question, this.shouldApprove() === true)
        this.log(`approval ${JSON.stringify(question)} -> ${decision.action} (${decision.reason})`)
        // The child may already be gone; a failed reply must not throw out of the parser.
        try {
          this.#write({
            jsonrpc: '2.0',
            id: message.id,
            result: { action: decision.action, content: {} },
          })
        } catch (error) {
          this.log(`approval reply failed: ${error.message}`)
        }
        return
      }
      try {
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `method not supported by dsh-codex-cu: ${message.method}`,
          },
        })
      } catch (error) {
        this.log(`method reply failed: ${error.message}`)
      }
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
        this.#cancel(id, `client timed out after ${timeoutMs}ms`)
        reject(new Error(
          `${name} timed out after ${timeoutMs}ms; the code may still be running on the server`,
        ))
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
    this.ready = false
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
