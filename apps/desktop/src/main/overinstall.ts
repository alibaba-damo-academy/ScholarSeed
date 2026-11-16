import { createHash } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'

const SETUP_PIPE_PREFIX = '\\\\.\\pipe\\scholarseed-setup-'
const SETUP_REQUEST = 'prepare\n'
const SETUP_COMMIT = 'commit\n'
const SETUP_TIMEOUT_MS = 120_000
const SETUP_FRAME_BYTES = 32

export function setupExitPipe(root: string): string {
  return (
    SETUP_PIPE_PREFIX +
    createHash('sha256').update(root.replace(/\\+$/, '').toLowerCase()).digest('hex')
  )
}

export interface SetupExitActions {
  confirm(): Promise<boolean>
  prepare(signal: AbortSignal): Promise<void>
  recover(): Promise<void>
  exit(): void
  failed(error: unknown): void
}

/** The request grants no silent exit authority: the running app asks its user.
 * The installer separately validates this pipe's native server PID and waits for
 * the installation's processes after the clean-shutdown acknowledgement. */
export function listenForSetupExit(endpoint: string, actions: SetupExitActions): Promise<Server> {
  let busy = false
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    const controller = new AbortController()
    socket.once('close', () => {
      sockets.delete(socket)
      controller.abort()
    })
    socket.on('error', () => controller.abort())
    socket.setTimeout(SETUP_TIMEOUT_MS, () => socket.destroy())
    let frame = ''
    let handled = false
    let acknowledge: ((chunk: Buffer) => void) | null = null
    socket.on('data', (chunk: Buffer) => {
      if (acknowledge) {
        acknowledge(chunk)
        return
      }
      if (handled) {
        socket.destroy()
        return
      }
      frame += chunk.toString('utf8')
      if (frame.length > SETUP_FRAME_BYTES || (frame.includes('\n') && frame !== SETUP_REQUEST)) {
        socket.destroy()
        return
      }
      if (frame !== SETUP_REQUEST) return
      handled = true
      if (busy) {
        socket.end('busy\n')
        return
      }
      busy = true
      void (async () => {
        let preparing = false
        try {
          if (!(await actions.confirm())) {
            socket.end('cancelled\n')
            return
          }
          controller.signal.throwIfAborted()
          preparing = true
          await actions.prepare(controller.signal)
          controller.signal.throwIfAborted()
          // Keep the pipe open until Setup has read the receipt. Windows pipe
          // closure is not delivery acknowledgement; a lost coordinator recovers.
          await new Promise<void>((resolve, reject) => {
            let commit = ''
            const abort = () => {
              acknowledge = null
              reject(new Error('Installer disconnected before exit'))
            }
            controller.signal.addEventListener('abort', abort, { once: true })
            acknowledge = (chunk) => {
              commit += chunk.toString('utf8')
              if (commit === SETUP_COMMIT) {
                acknowledge = null
                controller.signal.removeEventListener('abort', abort)
                resolve()
              } else if (commit.length >= SETUP_FRAME_BYTES || commit.includes('\n')) {
                socket.destroy()
              }
            }
            socket.write('ready\n', (error) => {
              if (error) socket.destroy()
            })
          })
          preparing = false
          socket.end()
          actions.exit()
        } catch (error) {
          if (preparing) {
            try {
              await actions.recover()
            } catch (recovery) {
              actions.failed(recovery)
            }
          }
          actions.failed(error)
          if (!socket.destroyed) socket.end('failed\n')
        } finally {
          busy = false
        }
      })()
    })
  })
  server.once('close', () => {
    for (const socket of sockets) socket.destroy()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => {
      server.removeListener('error', reject)
      server.on('error', actions.failed)
      resolve(server)
    })
  })
}
