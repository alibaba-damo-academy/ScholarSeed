const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')
const { expectedVersions, checkVersion, checkToolchain, checkUv, npmCommand, packageManagerName, diagnose } = require('../../../../../scripts/pre/toolchain.cjs')

const REPO = path.resolve(sourceDirectory, '../../../..')

test('packaging hooks declare direct build dependencies for isolated pnpm resolution', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDirectory, '../../package.json'), 'utf8'))
  for (const name of ['@electron/osx-sign', 'pe-library', 'resedit']) {
    assert.ok(Object.hasOwn(manifest.devDependencies, name), `${name} must be a direct build dependency`)
    assert.equal(manifest.dependencies?.[name], undefined)
  }
})

test('declared host tools are the actual installed tools', () => {
  const tools = checkToolchain(REPO)
  assert.equal(tools.node.version, expectedVersions(REPO).node)
  const expectedNpm = expectedVersions(REPO).npm
  if (expectedNpm) assert.equal(tools.npm.version, expectedNpm)
  for (const item of Object.values(tools)) if (item.path) assert.ok(path.isAbsolute(item.path))
})

test('version mismatch stops before installation and names the executable', () => {
  assert.throws(() => checkVersion('Node', '1.2.3', '4.5.6', '/wrong/node'), /1.2.3.*wrong\/node.*4.5.6/)
})

test('package manager detection defaults to pnpm and respects explicit runners', () => {
  assert.equal(packageManagerName({}), 'pnpm')
  assert.equal(packageManagerName({ npm_config_user_agent: 'npm/11.13.0 node/v24.16.0 darwin arm64' }), 'npm')
  assert.equal(packageManagerName({ npm_config_user_agent: 'yarn/1.22.22 npm/? node/v24.16.0 darwin arm64' }), 'yarn')
  assert.equal(packageManagerName({ npm_execpath: '/tmp/pnpm.cjs' }), 'pnpm')
})

test('uv itself rejects an incompatible required-version policy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-uv-policy-'))
  try {
    const filename = path.join(directory, 'uv.toml')
    fs.writeFileSync(filename, 'required-version = "==999.0.0"\n')
    assert.throws(() => execFileSync(process.env.UV || 'uv', ['--config-file', filename, 'cache', 'dir'],
      { stdio: 'pipe' }), error => /Required uv version/.test(error.stderr.toString()))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('the bootstrap rejects a wrong uv even when configuration cannot be parsed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-uv-bootstrap-'))
  try {
    fs.writeFileSync(path.join(directory, 'pyproject.toml'),
      '[tool.uv]\nrequired-version = ">=999.0.0"\nunknown-future-setting = true\n')
    assert.throws(() => checkUv(directory), /requires >= 999.0.0/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Windows npm launcher resolves to JavaScript rather than a shell command', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed npm spaces '))
  try {
    const launcher = path.join(directory, 'npm.cmd')
    const cli = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(launcher, '@echo off\r\n', { mode: 0o755 })
    fs.writeFileSync(path.join(directory, 'npm'), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(cli, '')
    const command = npmCommand({ npm_execpath: launcher })
    assert.equal(command.executable, process.execPath)
    assert.deepEqual(command.args, [fs.realpathSync(cli)])
    assert.deepEqual(npmCommand({ PATH: directory }).args, command.args)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('POSIX npm wrapper resolves the standard lib node_modules layout', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-node-prefix-'))
  try {
    const launcher = path.join(directory, 'bin', 'npm')
    const cli = path.join(directory, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(cli, '')
    const command = npmCommand({ PATH: path.dirname(launcher) })
    assert.equal(command.executable, process.execPath)
    assert.deepEqual(command.args, [fs.realpathSync(cli)])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('diagnostics collect every missing dependency without exposing configuration', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-doctor-'))
  try {
    const report = await diagnose(directory)
    assert.equal(report.ok, false)
    for (const name of ['node', 'npm', 'python', 'codex', 'electron']) {
      assert.equal(report.checks[name].ok, false)
      assert.ok(report.checks[name].error)
    }
    assert.equal('environment' in report, false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
