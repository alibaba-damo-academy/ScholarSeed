import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compileCandidate, publishCandidate, candidateNative, DevelopmentPublicationRejected } from '../development.mjs'

async function fixture(context, invalid = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scholarseed 候选 ' test-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'out', 'main'), { recursive: true })
  await fs.mkdir(path.join(root, 'out', 'protected'), { recursive: true })
  await fs.writeFile(path.join(root, 'out/protected/existing'), 'protected sentinel')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'candidate-test', version: '1.0.0', main: 'out/main/index.js' }))
  await fs.writeFile(path.join(root, 'out/main/index.js'), 'canonical sentinel')
  await fs.writeFile(path.join(root, 'main.ts'), invalid ? 'export const invalid = ;' : 'export const candidate = 42')
  await fs.writeFile(path.join(root, 'preload.ts'), 'export const preload = 43')
  await fs.writeFile(path.join(root, '.env.development'), 'BROWSER=candidate-browser\nBROWSER_ARGS=candidate-arguments\nNODE_ENV=development\n')
  await fs.writeFile(path.join(root, 'electron.vite.config.ts'), `
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
export async function desktopConfiguration({ protectedOutputRoot }) {
  mkdirSync(resolve(protectedOutputRoot, 'generation'), { recursive: true })
  writeFileSync(resolve(protectedOutputRoot, 'generation', 'manifest.json'), 'protected candidate')
  const target = name => ({ plugins: [{
    name: 'candidate-watch-guard',
    configResolved(config) { if (config.build.watch) throw new Error('watch forbidden') },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'hook.txt', source: 'owner hook retained' })
      if (name === 'main') this.emitFile({ type: 'asset', fileName: 'lease.node', source: 'fixture native bytes' })
    }
  }], build: {
    watch: {}, rollupOptions: { input: resolve(__dirname, name + '.ts') }
  } })
  return { main: target('main'), preload: target('preload'), renderer: { root: resolve(__dirname, 'renderer'), server: { host: '127.0.0.1', port: 5891, strictPort: true } } }
}
`)
  return root
}

test('compiles actual Vite main/preload builds into a new isolated candidate', async context => {
  const root = await fixture(context)
  const parent = path.join(root, 'candidates')
  const environment = { ...process.env }
  const result = await compileCandidate({ desktopRoot: root, parentDirectory: parent })
  assert.deepEqual({ ...process.env }, environment)
  assert.equal(await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8'), 'canonical sentinel')
  assert.match(await fs.readFile(path.join(result.main, 'main.js'), 'utf8'), /42/)
  assert.match(await fs.readFile(path.join(result.preload, 'preload.js'), 'utf8'), /43/)
  assert.equal(await fs.readFile(path.join(result.main, 'hook.txt'), 'utf8'), 'owner hook retained')
  assert.equal(await fs.readFile(path.join(result.preload, 'hook.txt'), 'utf8'), 'owner hook retained')
  assert.equal(await fs.readFile(path.join(root, 'out/protected/existing'), 'utf8'), 'protected sentinel')
  assert.equal(await fs.readFile(path.join(result.protected, 'generation', 'manifest.json'), 'utf8'), 'protected candidate')
  assert.ok(result.directory.startsWith(await fs.realpath(parent) + path.sep))
  assert.equal(result.published, false)
  assert.equal(result.rendererConfig.configFile, false)
  assert.equal(result.rendererConfig.root, path.join(await fs.realpath(root), 'renderer'))
  assert.equal(result.rendererConfig.server.port, 5891)
  assert.equal(result.rendererConfig.server.strictPort, true)
})

test('publication requires owned unchanged candidate and explicit stopped-instance contract', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  await assert.rejects(publishCandidate(candidate, root), /previous instance/)
  await assert.rejects(publishCandidate({ ...candidate }, root, { previousStopped: true }), /owned/)
  await fs.writeFile(path.join(candidate.main, 'main.js'), 'tampered')
  await assert.rejects(publishCandidate(candidate, root, { previousStopped: true }), /changed/)
  assert.equal(await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8'), 'canonical sentinel')
})

test('native candidate bytes require compiler ownership, complete unchanged outputs and ready state', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  const bytes = await candidateNative(candidate)
  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(bytes.toString(), 'fixture native bytes')
  await assert.rejects(candidateNative({ ...candidate }), /owned/)
  const filename = path.join(candidate.main, 'lease.node')
  await fs.writeFile(filename, 'changed native')
  await assert.rejects(candidateNative(candidate), /changed/)
  await fs.writeFile(filename, bytes)
  const preload = path.join(candidate.preload, 'preload.js')
  const original = await fs.readFile(preload)
  await fs.writeFile(preload, 'changed other output')
  await assert.rejects(candidateNative(candidate), /changed/)
  await fs.writeFile(preload, original)
  const publication = await publishCandidate(candidate, root, { previousStopped: true })
  await assert.rejects(candidateNative(candidate), /not ready/)
  await publication.commit()
})

test('publication commits complete outputs and retains old protected generations', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  const publication = await publishCandidate(candidate, root, { previousStopped: true })
  assert.equal(candidate.published, true)
  await assert.rejects(publishCandidate(candidate, root, { previousStopped: true }), /not ready/)
  assert.match(await fs.readFile(path.join(root, 'out/main/main.js'), 'utf8'), /42/)
  assert.match(await fs.readFile(path.join(root, 'out/preload/preload.js'), 'utf8'), /43/)
  assert.equal(await fs.readFile(path.join(root, 'out/protected/existing'), 'utf8'), 'protected sentinel')
  assert.equal(await fs.readFile(path.join(root, 'out/protected/generation/manifest.json'), 'utf8'), 'protected candidate')
  await publication.commit()
  assert.deepEqual((await fs.readdir(path.join(root, 'out'))).sort(), ['main', 'preload', 'protected'])
  await assert.rejects(publication.rollback({ previousStopped: true }), /no longer pending/)
})

test('caller-confirmed shutdown allows rollback and retry without losing candidate', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  const publication = await publishCandidate(candidate, root, { previousStopped: true })
  await assert.rejects(publication.rollback(), /new instance/)
  await publication.rollback({ previousStopped: true })
  assert.equal(candidate.published, false)
  assert.equal(await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8'), 'canonical sentinel')
  assert.equal(await fs.readFile(path.join(candidate.protected, 'generation/manifest.json'), 'utf8'), 'protected candidate')
  await (await publishCandidate(candidate, root, { previousStopped: true })).commit()
})

test('Windows-style rename refusal restores already moved outputs and permits retry', async context => {
  const root = await fixture(context)
  await fs.mkdir(path.join(root, 'out/preload'))
  await fs.writeFile(path.join(root, 'out/preload/old.js'), 'old preload')
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  const rename = fs.rename
  const canonicalPreload = path.join(await fs.realpath(root), 'out/preload')
  let refused = false
  fs.rename = async (source, destination) => {
    if (!refused && destination === canonicalPreload) {
      refused = true
      throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
    }
    return rename(source, destination)
  }
  try { await assert.rejects(publishCandidate(candidate, root, { previousStopped: true }), error => {
    assert.ok(error instanceof DevelopmentPublicationRejected)
    assert.equal(error.previousOutputsIntact, true)
    assert.match(error.message, /sharing violation/)
    return true
  }) }
  finally { fs.rename = rename }
  assert.equal(await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8'), 'canonical sentinel')
  assert.equal(await fs.readFile(path.join(root, 'out/preload/old.js'), 'utf8'), 'old preload')
  assert.equal(candidate.published, false)
  await (await publishCandidate(candidate, root, { previousStopped: true })).commit()
})

test('publication rejects linked candidate and linked canonical directory without following them', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  await fs.symlink(path.join(root, 'main.ts'), path.join(candidate.main, 'linked.js'))
  await assert.rejects(publishCandidate(candidate, root, { previousStopped: true }), /link/)
  await fs.unlink(path.join(candidate.main, 'linked.js'))
  await fs.symlink(candidate.preload, path.join(root, 'out/preload'), 'junction')
  await assert.rejects(publishCandidate(candidate, root, { previousStopped: true }), /directory/)
})

test('conflicting protected generation never overwrites canonical or unrelated protected files', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  await fs.mkdir(path.join(root, 'out/protected/generation'))
  await fs.writeFile(path.join(root, 'out/protected/generation/manifest.json'), 'other generation')
  await assert.rejects(publishCandidate(candidate, root, { previousStopped: true }), /collision/)
  assert.equal(await fs.readFile(path.join(root, 'out/protected/generation/manifest.json'), 'utf8'), 'other generation')
  assert.equal(await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8'), 'canonical sentinel')
})

test('rollback rename refusal preserves transaction backups and can be retried after lock release', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  const publication = await publishCandidate(candidate, root, { previousStopped: true })
  const rename = fs.rename
  fs.rename = async () => { throw Object.assign(new Error('locked rollback'), { code: 'EPERM' }) }
  try { await assert.rejects(publication.rollback({ previousStopped: true }), /locked rollback/) }
  finally { fs.rename = rename }
  const transaction = (await fs.readdir(path.join(root, 'out'))).find(name => name.startsWith('.development-'))
  assert.ok(transaction)
  assert.equal(await fs.readFile(path.join(root, 'out', transaction, 'main.previous/index.js'), 'utf8'), 'canonical sentinel')
  await publication.rollback({ previousStopped: true })
  assert.equal(await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8'), 'canonical sentinel')
})

for (const operation of ['rollback', 'commit']) {
  for (const changed of ['canonical', 'backup']) {
    test(`${operation} preserves transaction when ${changed} output changes externally`, async context => {
      const root = await fixture(context)
      const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
      const publication = await publishCandidate(candidate, root, { previousStopped: true })
      const transaction = (await fs.readdir(path.join(root, 'out'))).find(name => name.startsWith('.development-'))
      const destination = changed === 'canonical' ? path.join(root, 'out/main/main.js') : path.join(root, 'out', transaction, 'main.previous/index.js')
      await fs.writeFile(destination, 'external output')
      await assert.rejects(publication[operation]({ previousStopped: true }), /ownership|changed/)
      assert.equal(await fs.readFile(destination, 'utf8'), 'external output')
      assert.ok((await fs.stat(path.join(root, 'out', transaction))).isDirectory())
      assert.equal(candidate.published, true)
    })
  }
}

test('rollback rejects a byte-identical replacement directory by filesystem identity', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  const publication = await publishCandidate(candidate, root, { previousStopped: true })
  const canonical = path.join(root, 'out/main')
  const retained = path.join(root, 'out/externally-retained-main')
  await fs.rename(canonical, retained)
  await fs.cp(retained, canonical, { recursive: true })
  await assert.rejects(publication.rollback({ previousStopped: true }), /ownership changed/)
  assert.match(await fs.readFile(path.join(canonical, 'main.js'), 'utf8'), /42/)
  assert.match(await fs.readFile(path.join(retained, 'main.js'), 'utf8'), /42/)
})

test('publication never certifies previous outputs when recovery itself fails', async context => {
  const root = await fixture(context)
  const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
  const rename = fs.rename
  let moves = 0
  fs.rename = async (before, after) => {
    moves += 1
    if (moves >= 4) throw Object.assign(new Error('locked publication and rollback'), { code: 'EPERM' })
    return rename(before, after)
  }
  try {
    await assert.rejects(publishCandidate(candidate, root, { previousStopped: true }), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error instanceof DevelopmentPublicationRejected, false)
      assert.notEqual(error.previousOutputsIntact, true)
      return true
    })
  } finally { fs.rename = rename }
  assert.ok((await fs.readdir(path.join(root, 'out'))).some(name => name.startsWith('.development-')))
})

async function treeSnapshot(directory) {
  const entries = []
  async function visit(relative) {
    const filename = path.join(directory, relative)
    const stat = await fs.lstat(filename, { bigint: true })
    entries.push([relative, String(stat.dev), String(stat.ino), String(stat.birthtimeNs), stat.isFile() ? (await fs.readFile(filename)).toString('hex') : null])
    if (stat.isDirectory()) for (const name of (await fs.readdir(filename)).sort()) await visit(path.join(relative, name))
  }
  await visit('')
  return entries
}

for (const change of ['main-replaced', 'main-missing', 'preload-appeared', 'protected-replaced', 'out-replaced', 'transaction-replaced']) {
  test(`publication preserves initial ownership when ${change} during candidate copy`, async context => {
    const root = await fs.realpath(await fixture(context))
    const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
    const output = path.join(root, 'out')
    const copy = fs.cp
    let injected = false
    let preserved
    let expected
    let displaced
    fs.cp = async (source, destination, options) => {
      await copy(source, destination, options)
      if (injected) return
      injected = true
      const target = change.split('-')[0]
      preserved = target === 'out' ? output : target === 'transaction' ? path.dirname(destination) : path.join(output, target)
      if (change !== 'preload-appeared') {
        displaced = path.join(root, `displaced-${target}`)
        await fs.rename(preserved, displaced)
      }
      if (change !== 'main-missing') {
        if (change.endsWith('replaced')) await copy(displaced, preserved, { recursive: true })
        else await fs.mkdir(preserved)
        expected = await treeSnapshot(preserved)
      }
    }
    let failure
    try {
      try { await publishCandidate(candidate, root, { previousStopped: true }) } catch (error) { failure = error }
    } finally { fs.cp = copy }
    assert.equal(injected, true)
    assert.ok(failure, 'namespace changes must reject publication')
    assert.equal(failure instanceof DevelopmentPublicationRejected, false)
    assert.notEqual(failure.previousOutputsIntact, true)
    assert.equal(candidate.published, false)
    if (change === 'main-missing') await assert.rejects(fs.lstat(preserved), { code: 'ENOENT' })
    else assert.deepEqual(await treeSnapshot(preserved), expected)
    if (displaced) assert.ok((await fs.lstat(displaced)).isDirectory())
  })
}

for (const operation of ['commit', 'rollback']) {
  for (const target of ['out', 'protected', 'transaction']) {
    test(`${operation} preserves byte-identical foreign ${target} root replacements`, async context => {
      const root = await fs.realpath(await fixture(context))
      const candidate = await compileCandidate({ desktopRoot: root, parentDirectory: path.join(root, 'candidates') })
      const publication = await publishCandidate(candidate, root, { previousStopped: true })
      const directory = target === 'transaction' ? publication.directory : target === 'out' ? path.join(root, 'out') : path.join(root, 'out/protected')
      const displaced = path.join(root, `displaced-${target}`)
      await fs.rename(directory, displaced)
      await fs.cp(displaced, directory, { recursive: true })
      const replacement = await treeSnapshot(directory)
      const original = await treeSnapshot(displaced)
      await assert.rejects(publication[operation]({ previousStopped: true }), /ownership changed/)
      assert.deepEqual(await treeSnapshot(directory), replacement)
      assert.deepEqual(await treeSnapshot(displaced), original)
    })
  }
}

test('failed actual compilation removes only its candidate and preserves canonical outputs', async context => {
  const root = await fixture(context, true)
  const parent = path.join(root, 'candidates')
  await fs.mkdir(parent)
  await fs.writeFile(path.join(parent, 'existing'), 'retain')
  const environment = { ...process.env }
  await assert.rejects(compileCandidate({ desktopRoot: root, parentDirectory: parent }))
  assert.deepEqual({ ...process.env }, environment)
  assert.deepEqual(await fs.readdir(parent), ['existing'])
  assert.equal(await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8'), 'canonical sentinel')
  assert.equal(await fs.readFile(path.join(root, 'out/protected/existing'), 'utf8'), 'protected sentinel')
})
