import { createConnection } from 'node:net'
import type { Readable } from 'node:stream'

const LOOPBACK = '127.0.0.1'
const FRAME_BYTES = 4096
export const DEVELOPMENT_CONTROL_TIMEOUT_MS = 40_000
const GENERATION = /^[a-f0-9]{32}$/
const TOKEN = /^[a-f0-9]{64}$/
const OPERATIONS = new Set(['quiesce_if_idle', 'resume', 'exit'])
export const DEVELOPMENT_CONTROL_ARGUMENT = '--development-control'

export interface DevelopmentControlOptions {
  enabled: boolean
  input: Readable
  timeoutMs?: number
  quiesceIfIdle: () => Promise<string | null>
  resume: (generation: string) => Promise<void>
  prepareExit?: () => Promise<void>
  exit: () => void
}

function object(line: string, keys: string[]): Record<string, unknown> {
  const value = JSON.parse(line)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('private development frame rejected')
  const observed = [...line.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((match) =>
    JSON.parse(`"${match[1]}"`)
  )
  if (
    observed.length !== keys.length ||
    new Set(observed).size !== keys.length ||
    observed.some((key) => !keys.includes(key)) ||
    Object.keys(value).length !== keys.length
  )
    throw new Error('private development frame rejected')
  return value
}

function line(input: Readable, timeoutMs: number): Promise<{ value: string; remaining: Buffer }> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const finish = (error?: Error, value?: string, remaining = Buffer.alloc(0)) => {
      clearTimeout(timer)
      input.pause()
      input.removeListener('data', data)
      input.removeListener('error', failed)
      input.removeListener('end', failed)
      input.removeListener('close', failed)
      if (error) reject(error)
      else resolve({ value: value!, remaining })
    }
    const failed = () => finish(new Error('private development channel unavailable'))
    const data = (chunk: Buffer) => {
      if (received.length + chunk.length > FRAME_BYTES) return failed()
      received = Buffer.concat([received, chunk])
      const boundary = received.indexOf(10)
      if ((boundary < 0 && received.length > FRAME_BYTES) || boundary > FRAME_BYTES) return failed()
      if (boundary >= 0)
        finish(
          undefined,
          received.subarray(0, boundary).toString('utf8'),
          received.subarray(boundary + 1)
        )
    }
    const timer = setTimeout(failed, timeoutMs)
    input.on('data', data)
    input.once('error', failed)
    input.once('end', failed)
    input.once('close', failed)
    input.resume()
  })
}

async function bounded<Value>(operation: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('private development operation outcome unavailable')),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function startDevelopmentControl(
  options: DevelopmentControlOptions
): Promise<{ close(): void } | null> {
  if (!options.enabled) return null
  const timeoutMs = options.timeoutMs ?? DEVELOPMENT_CONTROL_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEVELOPMENT_CONTROL_TIMEOUT_MS)
    throw new Error('invalid private development deadline')
  const bootstrap = await line(options.input, timeoutMs)
  if (bootstrap.remaining.length) throw new Error('private development bootstrap rejected')
  const identity = object(bootstrap.value, ['version', 'port', 'token'])
  if (
    identity.version !== 1 ||
    !Number.isInteger(identity.port) ||
    Number(identity.port) < 1 ||
    Number(identity.port) > 65535 ||
    typeof identity.token !== 'string' ||
    !TOKEN.test(identity.token)
  )
    throw new Error('private development bootstrap rejected')
  const socket = createConnection({ host: LOOPBACK, port: Number(identity.port) })
  let closed = false
  let unknown = false
  let generation: string | null = null
  let pending = false
  let buffer = Buffer.alloc(0)
  let frameTimer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    closed = true
    clearTimeout(frameTimer)
    socket.destroy()
  }
  socket.on('error', close)
  socket.on('close', () => {
    closed = true
    clearTimeout(frameTimer)
  })
  const send = (response: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('private development channel unavailable'))
        return
      }
      const header = Buffer.alloc(4)
      header.writeUInt32BE(response.length)
      socket.write(Buffer.concat([header, response]), (error) =>
        error ? reject(error) : resolve()
      )
    })
  const execute = async (raw: string) => {
    try {
      const command = object(raw, ['operation', 'generation'])
      if (
        !OPERATIONS.has(String(command.operation)) ||
        !(
          command.generation === null ||
          (typeof command.generation === 'string' && GENERATION.test(command.generation))
        )
      )
        throw new Error('private development command rejected')
      if (unknown) {
        await send(Buffer.from([2]))
        return
      }
      if (
        command.operation === 'quiesce_if_idle' &&
        command.generation === null &&
        generation === null
      ) {
        let admitted: string | null
        try {
          admitted = await bounded(options.quiesceIfIdle(), timeoutMs)
        } catch {
          unknown = true
          await send(Buffer.from([2]))
          return
        }
        if (closed) return
        if (admitted === null) {
          await send(Buffer.from([0]))
          return
        }
        if (typeof admitted !== 'string' || !GENERATION.test(admitted)) {
          unknown = true
          await send(Buffer.from([2]))
          return
        }
        generation = admitted
        await send(Buffer.from('\x01' + generation))
      } else if (
        generation !== null &&
        command.generation === generation &&
        command.operation === 'resume'
      ) {
        try {
          await bounded(options.resume(generation), timeoutMs)
        } catch {
          unknown = true
          await send(Buffer.from([2]))
          return
        }
        if (closed) return
        generation = null
        await send(Buffer.from([1]))
      } else if (
        generation !== null &&
        command.generation === generation &&
        command.operation === 'exit'
      ) {
        if (options.prepareExit) {
          try {
            await bounded(options.prepareExit(), timeoutMs)
          } catch {
            unknown = true
            await send(Buffer.from([2]))
            return
          }
        }
        if (closed) return
        await send(Buffer.from([1]))
        if (!closed) {
          unknown = true
          try {
            options.exit()
          } catch {
            close()
          }
        }
      } else await send(Buffer.from([2]))
    } catch {
      if (!closed) await send(Buffer.from([2])).catch(close)
    } finally {
      pending = false
    }
  }
  const receive = (chunk: Buffer) => {
    if (closed) return
    if (buffer.length + chunk.length > FRAME_BYTES) {
      close()
      return
    }
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > FRAME_BYTES) {
      close()
      return
    }
    const boundary = buffer.indexOf(10)
    if (boundary < 0) {
      frameTimer ??= setTimeout(close, timeoutMs)
      return
    }
    clearTimeout(frameTimer)
    frameTimer = undefined
    if (pending || boundary !== buffer.length - 1) {
      close()
      return
    }
    const raw = buffer.subarray(0, boundary).toString('utf8')
    buffer = Buffer.alloc(0)
    pending = true
    void execute(raw).catch(close)
  }
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
        socket.once('close', () => reject(new Error('private development connection unavailable')))
      }),
      timeoutMs
    )
    const ready = line(socket, timeoutMs)
    socket.write(JSON.stringify({ token: identity.token }) + '\n')
    identity.token = ''
    const authenticated = await ready
    if (authenticated.value !== 'ready')
      throw new Error('private development authentication rejected')
    socket.on('data', receive)
    if (authenticated.remaining.length) receive(authenticated.remaining)
    socket.resume()
    return { close }
  } catch {
    close()
    throw new Error('private development control unavailable')
  }
}
