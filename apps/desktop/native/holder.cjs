// Real-process native contract driver, never loaded by product entrypoints.
const net = require('node:net')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { beginDomains, createDirectory } = require('./domains.cjs')
const { randomBytes } = require('node:crypto')
const { Worker } = require('node:worker_threads')
const path = require('node:path')

// Electron retains its pre-entry switches in argv; the driver owns the final three arguments.
const [library, filename, mode] = process.argv.slice(-3)
const api = require(library)
const app = process.versions.electron ? require('electron').app : null
if (
  app &&
  path.resolve(app.getPath('userData')) !== path.resolve(process.env.SCHOLARSEED_LEASE_PROFILE)
) {
  throw new Error('Electron did not select the isolated profile before the main entry')
}
const exit = (code) => (app ? app.exit(code) : process.exit(code))

function creationBarrier(gate) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  fs.writeFileSync(filename + '.ready', 'ready')
  const deadline = Date.now() + 20000
  while (!fs.existsSync(gate)) {
    if (Date.now() >= deadline) throw new Error('creation race barrier timed out')
    Atomics.wait(wait, 0, 0, 10)
  }
}

async function main() {
  let lease
  let directory
  let domains
  let contents
  if (mode === 'read-fifo') {
    directory = api.pin(filename, false)
    assert.throws(() => api.readAt(directory, 'pipe', 1024), { code: 'ERR_LEASE_FILE' })
  } else if (mode === 'read-replaced') {
    directory = api.pin(filename, false)
    fs.renameSync(filename, filename + '-moved')
    fs.mkdirSync(filename)
    fs.writeFileSync(path.join(filename, 'storage-config.json'), 'replacement')
    contents = api.readAt(directory, 'storage-config.json', 1024 * 1024)
  } else if (mode === 'relative-replaced') {
    directory = api.pin(filename, false)
    fs.renameSync(filename, filename + '-moved')
    fs.mkdirSync(filename)
    lease = api.acquireAt(directory, 'occupancy', true)
  } else if (mode === 'coordinator-race') {
    const selected = JSON.parse(fs.readFileSync(filename, 'utf8'))
    creationBarrier(selected.gate)
    directory = api.pin(selected.coordinator, true)
    lease = api.acquireAt(directory, 'shared-slot', false)
    contents = Buffer.from(JSON.stringify(api.lineage(directory)))
  } else if (mode === 'creation-race') {
    const selected = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const wrapped = {
      pin: api.pin,
      lineage: api.lineage,
      acquireAt: api.acquireAt,
      release: api.release,
      createChild(...args) {
        creationBarrier(selected.gate)
        return api.createChild(...args)
      },
    }
    const identity = createDirectory(wrapped, selected.coordinator, selected.roots[0], 'same-child')
    fs.writeFileSync(filename + '.identity', identity)
  } else if (mode.startsWith('creation-uncertain-')) {
    const selected = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const childPath = path.join(selected.roots[0], 'new-child')
    let childPin
    const wrapped = {
      pin(...args) {
        const value = api.pin(...args)
        if (args[0] === childPath && !childPin) childPin = value
        return value
      },
      lineage: api.lineage,
      acquireAt: api.acquireAt,
      createChild(...args) {
        const value = api.createChild(...args)
        if (mode === 'creation-uncertain-native')
          throw Object.assign(new Error('injected child close receipt uncertainty'), {
            code: 'ERR_LEASE_RELEASE',
          })
        return value
      },
      release(handle) {
        api.release(handle)
        if (handle === childPin)
          throw new Error('injected selected child close receipt uncertainty')
      },
    }
    assert.throws(
      () => createDirectory(wrapped, selected.coordinator, selected.roots[0], 'new-child'),
      {
        code: 'ERR_DOMAIN_RELEASE',
      }
    )
  } else if (mode === 'domain-read' || mode.startsWith('domain-read-uncertain-')) {
    const selected = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const boundary = mode.slice('domain-read-uncertain-'.length)
    let releasesUntilFailure = Infinity
    const native =
      mode === 'domain-read'
        ? api
        : {
            pin: api.pin,
            lineage: api.lineage,
            acquireAt: api.acquireAt,
            release(handle) {
              api.release(handle)
              if (--releasesUntilFailure === 0)
                throw new Error('injected revalidation close receipt uncertainty')
            },
            readAt(...args) {
              const bytes = api.readAt(...args)
              if (boundary === 'after') releasesUntilFailure = 1
              if (boundary === 'native')
                throw Object.assign(new Error('injected read close receipt uncertainty'), {
                  code: 'ERR_LEASE_RELEASE',
                })
              return bytes
            },
          }
    domains = beginDomains(native, selected.coordinator, selected.roots)
    domains.occupy()
    if (mode === 'domain-read')
      contents = domains.read(selected.roots[0], 'storage-config.json', 1024)
    else {
      if (boundary === 'before') releasesUntilFailure = 1
      assert.throws(() => domains.read(selected.roots[0], 'storage-config.json', 1024), {
        code: 'ERR_DOMAIN_RELEASE',
      })
      assert.throws(() => domains.admit(), /only an occupied writer/)
      assert.throws(() => domains.close(), { code: 'ERR_DOMAIN_RELEASE' })
    }
  } else if (mode.startsWith('domain-uncertain-')) {
    const selected = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const boundary = mode.slice('domain-uncertain-'.length)
    let releasesUntilFailure = boundary === 'begin' ? 1 : Infinity
    let blocker
    let acquisitions = 0
    const wrapped = {
      pin: api.pin,
      lineage: api.lineage,
      acquireAt(...args) {
        if (boundary === 'cleanup' && args[1].includes('-occupancy-') && ++acquisitions === 2)
          blocker = api.acquireAt(args[0], args[1], true)
        return api.acquireAt(...args)
      },
      release(handle) {
        api.release(handle)
        if (--releasesUntilFailure === 0)
          throw new Error('injected uncertain close receipt after actual native close')
      },
    }
    if (boundary === 'begin') {
      assert.throws(() => beginDomains(wrapped, selected.coordinator, selected.roots), {
        code: 'ERR_DOMAIN_RELEASE',
      })
    } else {
      domains = beginDomains(wrapped, selected.coordinator, selected.roots)
      if (['admit', 'admission', 'close'].includes(boundary)) domains.occupy()
      // Admission failure occurs after every successful temporary recheck close.
      releasesUntilFailure = boundary === 'admission' ? selected.roots.length + 2 : 1
      assert.throws(
        () => {
          if (boundary === 'close') domains.close()
          else if (['occupy', 'cleanup'].includes(boundary)) domains.occupy()
          else domains.admit()
        },
        { code: 'ERR_DOMAIN_RELEASE' }
      )
      if (blocker) api.release(blocker)
      assert.throws(() => domains.close(), { code: 'ERR_DOMAIN_RELEASE' })
      assert.throws(() => domains.occupy(), /guarded admission/)
      assert.throws(() => domains.admit(), /only an occupied writer/)
    }
    assert.equal(releasesUntilFailure, 0, 'uncertain close must stop the same release group')
  } else if (mode.startsWith('domain-')) {
    const selected = JSON.parse(fs.readFileSync(filename, 'utf8'))
    domains = beginDomains(api, selected.coordinator, selected.roots, mode !== 'domain-write')
    domains.occupy()
    if (mode === 'domain-write') domains.admit()
  } else if (mode.endsWith('environment')) {
    const worker = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const api = require(workerData.library);
       if (workerData.pinned) {
         const path = require('node:path');
         const pin = api.pin(path.dirname(workerData.filename), false);
         api.acquireAt(pin, path.basename(workerData.filename), false);
       } else api.acquire(workerData.filename, false);
       parentPort.postMessage('held');
       setInterval(() => {}, 1000);`,
      { eval: true, workerData: { library, filename, pinned: mode.startsWith('directory') } }
    )
    await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => reject(new Error(`worker ended before admission: ${code}`)))
    })
    await worker.terminate()
  } else {
    if (mode.startsWith('directory')) {
      directory = api.pin(path.dirname(filename), false)
      lease = api.acquireAt(directory, path.basename(filename), mode.endsWith('exclusive'))
    } else lease = api.acquire(filename, mode === 'exclusive')
    if (mode === 'gc') {
      lease = null
      if (!global.gc) throw new Error('GC contract requires --expose-gc')
      global.gc()
    }
  }
  const token = randomBytes(24).toString('hex')
  const server = net.createServer((socket) => {
    socket.once('data', (bytes) => {
      if (bytes.toString() !== token) return socket.destroy()
      if (domains) domains.close()
      if (lease) api.release(lease)
      if (directory) api.release(directory)
      socket.end('closed', () => exit(0))
    })
  })
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(
      JSON.stringify({
        port: server.address().port,
        token,
        versions: { node: process.versions.node, electron: process.versions.electron },
        contents: contents?.toString('base64'),
      }) + '\n'
    )
  })
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  exit(1)
})
