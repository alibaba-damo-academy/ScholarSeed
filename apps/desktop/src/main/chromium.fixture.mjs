import { closeSync, createReadStream, createWriteStream } from 'node:fs'

const mode = process.argv[2]
const command = createReadStream(null, { fd: 3, autoClose: false })
const output = createWriteStream(null, { fd: 4, autoClose: false })
if (mode === 'late-create') process.stderr.write('late-create-ready\n')
let pending = Buffer.alloc(0)
let delayedCreation = false
let pendingCloseId
const delayedCreationMs = 400
command.on('data', chunk => {
  pending = Buffer.concat([pending, chunk])
  for (let end = pending.indexOf(0); end !== -1; end = pending.indexOf(0)) {
    const message = JSON.parse(pending.subarray(0, end).toString())
    pending = pending.subarray(end + 1)
    if (mode === 'crash') process.exit(7)
    if (mode === 'silent') continue
    if (mode === 'broken') { output.end(() => closeSync(4)); continue }
    if (mode === 'oversized') {
      output.write(`${JSON.stringify({ method: 'Target.targetCreated', params: {} })}\0`)
      output.write(Buffer.alloc(32 * 1024 * 1024 + 1, 65))
      continue
    }
    if (mode === 'protocol-error') {
      output.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Not supported', data: { reason: 'fixture' } } })}\0`)
      continue
    }
    if (mode === 'late-create') {
      if (message.method === 'Target.attachToBrowserTarget') {
        output.write(`${JSON.stringify({ id: message.id, result: { sessionId: 'fixture-browser' } })}\0`)
      } else if (message.method === 'Browser.getVersion') {
        output.write(`${JSON.stringify({ id: message.id, result: { product: 'fixture' } })}\0`)
      } else if (message.method === 'Target.createBrowserContext' || message.method === 'Target.createTarget') {
        delayedCreation = true
        setTimeout(() => {
          const result = message.method === 'Target.createBrowserContext'
            ? { browserContextId: 'late-context' } : { targetId: 'late-target' }
          output.write(`${JSON.stringify({ id: message.id, result })}\0`, () => {
            process.stderr.write('late-create-delivered\n', () => {
              if (pendingCloseId !== undefined) {
                output.write(`${JSON.stringify({ id: pendingCloseId, result: {} })}\0`)
                setTimeout(() => process.exit(0), 20)
              }
            })
          })
        }, delayedCreationMs)
      } else if (message.method === 'Browser.close') {
        if (delayedCreation) pendingCloseId = message.id
        else {
          output.write(`${JSON.stringify({ id: message.id, result: {} })}\0`)
          setTimeout(() => process.exit(0), 20)
        }
      }
      continue
    }
    const result = message.method === 'Browser.getVersion' ? { product: 'fixture' } : { targetInfos: [] }
    output.write(`${JSON.stringify({ method: 'Target.targetCreated', params: {} })}\0`)
    output.write(`${JSON.stringify({ id: message.id, result })}\0`)
    if (message.method === 'Browser.close') process.exit(0)
  }
})

// Protocol deadlines start after the fixture has installed its pipe reader.
if (process.send) {
  process.send({ ready: true })
  process.disconnect()
}
