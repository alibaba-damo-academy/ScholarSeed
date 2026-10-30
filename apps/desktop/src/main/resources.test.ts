import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  applicationExecutable,
  applicationResources,
  applicationInstallation,
  applicationIcon,
  applicationRenderer,
} from './resources.ts'

const root = resolve('installation with spaces 书深')
const current = join(root, 'current')
const engine = join(root, 'runtime', 'electron', '44.3.0-r1')
const application = { isPackaged: true, getAppPath: () => join(current, 'resources', 'app.asar') }
const host = {
  platform: 'win32',
  resourcesPath: join(engine, 'resources'),
  execPath: join(engine, 'ScholarSeedEngine.exe'),
}

test('renderer assets follow application resources on both packaged platforms', () => {
  assert.equal(applicationRenderer(application, host), join(current, 'resources', 'renderer'))
  const macHost = {
    ...host,
    platform: 'darwin',
    resourcesPath: join(root, 'Contents', 'Resources'),
  }
  assert.equal(applicationRenderer(application, macHost), join(macHost.resourcesPath, 'renderer'))
  const changed = { ...host, resourcesPath: join(root, 'another-engine', 'resources') }
  assert.equal(applicationRenderer(application, changed), applicationRenderer(application, host))
})

test('development renderer assets follow the application checkout rather than Electron resources', () => {
  const development = { isPackaged: false, getAppPath: () => root }
  for (const platform of ['darwin', 'win32']) {
    assert.equal(
      applicationRenderer(development, { ...host, platform }),
      join(root, 'out', 'renderer')
    )
  }
})

test('asset server and all native overlay consumers share the renderer resolver', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.equal(source.match(/directory: applicationRenderer\(app\)/g)?.length, 3)
  assert.ok(source.includes('serveAssets(applicationRenderer(app))'))
  assert.equal(source.includes("directory: join(__dirname, '../renderer')"), false)
})

test('packaged Windows code resources and stable launcher are separate from the engine', () => {
  assert.equal(applicationResources(application, host), join(current, 'resources'))
  assert.equal(applicationExecutable(application, host), join(current, 'ScholarSeed.exe'))
  assert.equal(host.execPath, join(engine, 'ScholarSeedEngine.exe'))
  assert.equal(host.resourcesPath, join(engine, 'resources'))
})
test('changing Electron versions does not change the program or launcher paths', () => {
  const changed = {
    ...host,
    execPath: join(root, 'runtime', 'electron', '45.0.0-r1', 'ScholarSeedEngine.exe'),
    resourcesPath: join(root, 'runtime', 'electron', '45.0.0-r1', 'resources'),
  }
  assert.equal(applicationResources(application, changed), applicationResources(application, host))
  assert.equal(
    applicationExecutable(application, changed),
    applicationExecutable(application, host)
  )
})
test('packaged Windows rejects missing, relative and non-current app archives', () => {
  for (const appPath of [
    '',
    'current/resources/app.asar',
    join(engine, 'resources', 'app.asar'),
    join(current, 'resources', 'app'),
    join(current, 'app.asar'),
  ]) {
    const invalid = { isPackaged: true, getAppPath: () => appPath }
    assert.throws(() => applicationResources(invalid, host), /current\/resources\/app.asar/)
    assert.throws(() => applicationExecutable(invalid, host), /current\/resources\/app.asar/)
  }
})
test('macOS and development preserve the existing engine and resource paths exactly', () => {
  const unread = {
    isPackaged: true,
    getAppPath(): string {
      throw new Error('app path must not be consulted')
    },
  }
  for (const platform of ['darwin', 'linux']) {
    const unchanged = { ...host, platform }
    assert.equal(applicationResources(unread, unchanged), host.resourcesPath)
    assert.equal(applicationExecutable(unread, unchanged), host.execPath)
  }
  const development = { ...unread, isPackaged: false }
  assert.equal(applicationResources(development, host), host.resourcesPath)
  assert.equal(applicationExecutable(development, host), host.execPath)
})

test('installation-wide process checks cover both engine and launcher beneath the stable root', () => {
  assert.deepEqual(applicationInstallation(application, host), {
    root,
    executables: ['ScholarSeed.exe', 'ScholarSeedEngine.exe'],
  })
  const changed = {
    ...host,
    execPath: join(root, 'runtime', 'electron', '45.0.0-r1', 'ScholarSeedEngine.exe'),
  }
  assert.deepEqual(
    applicationInstallation(application, changed),
    applicationInstallation(application, host)
  )
  const same = { ...host, execPath: join(current, 'ScholarSeed.exe') }
  assert.deepEqual(applicationInstallation(application, same), {
    root,
    executables: ['ScholarSeed.exe'],
  })
})

test('Windows packaged windows use the program icon instead of the upstream engine icon', () => {
  const config = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const icon = config.build.extraResources.find(
    (resource: { from: string; to: string }) => resource.from === 'resources/windows.ico'
  )
  assert.equal(icon.to, 'windows-tray.ico')
  assert.equal(applicationIcon(application, host), join(current, 'resources', icon.to))
  assert.equal(applicationIcon(application, { ...host, platform: 'darwin' }), undefined)
  assert.equal(applicationIcon({ ...application, isPackaged: false }, host), undefined)
})
