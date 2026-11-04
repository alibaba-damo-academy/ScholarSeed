import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { createServer } from 'vite'
import { PREVIEW_CATALOG } from '../../preview/catalog.ts'
import { PREVIEW_ORIGIN } from '../../preview/constants.ts'

const require = createRequire(import.meta.url)
const { acquire } = require('../../../../scripts/shared/lease.cjs')
const { launchLong } = require('../../../../scripts/shared/execution.cjs')
const { prepareNative, readNative } = require('../cd/seal.cjs')
const { ensurePrivateDirectory } = require('../shared/build-state.cjs')
const { artifactCache, matches } = require('../../../../scripts/shared/artifacts.cjs')
const nativePolicy = require('../../native/toolchain.json')
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const artifactRoot = path.join(desktop, 'test-results', 'pdfe-native')
const OS_ENVIRONMENT = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|SystemRoot|WINDIR|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA|DISPLAY|WAYLAND_DISPLAY|XDG_.*|DBUS_SESSION_BUS_ADDRESS)$/i
export const pdfeEnvironment = (environment = process.env) => Object.fromEntries(Object.entries(environment).filter(([key]) => OS_ENVIRONMENT.test(key)))

async function cachedNativeInputs() {
  const inputs = {}
  const selected = { headers: nativePolicy.headers, license: nativePolicy.license, ...(process.platform === 'win32' ? { compiler: nativePolicy.windows.compiler, library: nativePolicy.windows.library } : {}) }
  for (const [key, artifact] of Object.entries(selected)) {
    const filename = path.join(artifactCache(), artifact.sha256)
    if (!await matches(filename, artifact)) throw new Error('PDFE native prerequisite is not cached: ' + artifact.filename)
    inputs[key] = filename
  }
  return inputs
}

export async function buildPdfe(origin = PREVIEW_ORIGIN) {
  execFileSync(process.execPath, [path.join(desktop, 'scripts/pre/security.cjs'), '--check'], { cwd: desktop, stdio: 'inherit' })
  const artifacts = await cachedNativeInputs()
  ensurePrivateDirectory(artifactRoot)
  const output = fs.mkdtempSync(path.join(artifactRoot, 'run-'))
  const application = path.join(output, 'app')
  fs.mkdirSync(application, { mode: 0o700 })
  const packageJson = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
  const manifest = {
    schema: 1, origin, instance: randomUUID(),
    initial: { pageId: 'page-home', sceneId: 'home-browse' },
    pages: PREVIEW_CATALOG.map(page => ({ id: page.id, scenes: page.scenarios.map(scene => scene.id), available: Boolean(page.target || page.host), components: page.launch?.kind === 'components' })),
  }
  fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify({ name: 'scholarseed-pdfe', version: packageJson.version, main: 'main.cjs' }), { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(path.join(application, 'pdfe.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
  await build({ entryPoints: [path.join(desktop, 'src/main/pdfe.ts')], outfile: path.join(application, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', './lease.node', './fonts.node'], sourcemap: true })
  await build({ entryPoints: [path.join(desktop, 'src/preload/pdfe.ts')], outfile: path.join(application, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true })
  const nativeDirectory = path.join(output, 'native')
  const frozen = await prepareNative({ directory: nativeDirectory, signing: { mode: process.platform === 'darwin' ? 'ad-hoc-local-only' : 'unsigned-dev' }, runContract: false, artifacts })
  const libraries = readNative(nativeDirectory, frozen)
  for (const [name, bytes] of libraries) fs.writeFileSync(path.join(application, name), bytes, { mode: 0o600, flag: 'wx' })
  console.log('[pdfe] application ' + application)
  return application
}

export async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 1 || args[0] !== '--build-only')) throw new Error('Usage: pdfe.mjs [--build-only]')
  const lease = acquire({ mode: 'read', resources: [path.join(desktop, 'node_modules')] })
  let server
  let releaseAllowed = true
  try {
    const application = await buildPdfe()
    if (args[0] === '--build-only') return
    server = await createServer({ configFile: path.join(desktop, 'vite.preview.config.ts'), clearScreen: false })
    await server.listen()
    const executable = require('electron')
    try {
      const result = await launchLong(executable, [application], { cwd: desktop, env: pdfeEnvironment() })
      releaseAllowed = result.shutdownConfirmed
    } catch (error) {
      releaseAllowed = error.shutdownConfirmed !== false
      throw error
    }
  } finally {
    await server?.close()
    if (releaseAllowed) lease.release()
    else console.error('[pdfe] native process shutdown unconfirmed; dependency lease retained')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('[pdfe] ' + error.message); process.exitCode = error.exitCode ?? 1 })
}
