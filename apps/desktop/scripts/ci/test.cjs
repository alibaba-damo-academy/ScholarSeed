const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { childExitCode } = require('../../../../scripts/shared/execution.cjs')

const DESKTOP = path.resolve(__dirname, '../..')
const TEST_GLOBS = Object.freeze({
  '*.test.ts': { directory: '', recursive: false },
  'src/**/*.test.ts': { directory: 'src', recursive: true },
  'preview/*.test.ts': { directory: 'preview', recursive: false },
  'e2e/fixtures/*.test.ts': { directory: 'e2e/fixtures', recursive: false },
})
const TEST_FILES = Object.freeze([
  'e2e/fixtures/evidence.test.mjs',
  'e2e/fixtures/observation.test.mjs',
  '../../packages/ui/validation.test.ts',
  '../../packages/ui/layout.test.ts',
  '../../packages/ui/messages.test.ts',
  '../../packages/ui/preview/native.test.cjs',
  'src/renderer/src/components/primitive/images.render.test.cjs',
  '../../packages/ui/build.test.cjs',
  '../../packages/ui/catalog.test.cjs',
  '../../packages/ui/plugins.test.cjs',
  '../../packages/ui/preview/schema.test.mjs',
  '../../packages/ui/preview/directory.test.mjs',
  '../../packages/ui/preview/browser.test.cjs',
  '../../packages/ui/render.test.cjs',
  '../../packages/ui/research.test.cjs',
  '../../packages/ui/scope.test.cjs',
  '../../packages/ui/sdk.test.cjs',
  '../../packages/ui/statistics.test.ts',
  '../../packages/ui/templates.test.cjs',
  'preview/quality.test.mjs',
  '../../scripts/shared/__tests__/lease.test.cjs',
  '../../scripts/dev/__tests__/desktop.test.cjs',
  '../../scripts/shared/__tests__/timing.test.cjs',
  '../../scripts/shared/__tests__/permissions.test.cjs',
  '../../scripts/ci/__tests__/format.test.cjs',
  '../../scripts/pre/__tests__/cleanup.test.cjs',
  '../../scripts/pre/__tests__/commands.test.cjs',
  '../../scripts/pre/__tests__/symlinks.test.cjs',
  '../../scripts/pre/__tests__/toolchain-install.test.cjs',
  '../../scripts/cd/__tests__/updater-session.test.cjs',
  '../../scripts/shared/__tests__/dependencies.test.cjs',
  '../../scripts/shared/__tests__/platform.test.cjs',
  '../../scripts/shared/__tests__/migration.test.cjs',
  'scripts/pre/__tests__/electron.test.cjs',
  'scripts/dev/__tests__/lease.test.cjs',
  'scripts/dev/__tests__/pdfe.test.mjs',
  'scripts/shared/__tests__/temporary-cleanup.test.cjs',
  'scripts/shared/__tests__/utils.test.cjs',
  'scripts/shared/__tests__/component-cache.test.cjs',
  'scripts/cd/__tests__/build.test.cjs',
  'scripts/cd/__tests__/updater.test.cjs',
  'native/shipit/fingerprint.test.cjs',
  'scripts/cd/__tests__/archive_inventory.test.cjs',
  'scripts/cd/__tests__/windows-runtime.test.cjs',
  'scripts/recovery.test.ts',
  'scripts/cd/__tests__/signer.test.cjs',
  'scripts/cd/__tests__/wheels.test.cjs',
  'scripts/cd/__tests__/velobundle.test.mjs',
  'scripts/dev/__tests__/development.test.mjs',
  'scripts/dev/__tests__/supervision.test.mjs',
  'scripts/dev/__tests__/worker.test.cjs',
  'scripts/shared/__tests__/native.test.cjs',
  'scripts/shared/__tests__/macos.test.cjs',
  'scripts/shared/__tests__/probe.test.cjs',
  'native/observations.test.cjs',
  'native/registry.test.cjs',
  'native/storage.test.cjs',
  'scripts/shared/__tests__/styles.test.cjs',
  'scripts/shared/__tests__/openui.test.cjs',
  'scripts/ci/__tests__/reuse.test.mjs',
  'scripts/ci/__tests__/commands.test.cjs',
  'scripts/ci/__tests__/lifecycle.test.cjs',
  'scripts/ci/__tests__/types.test.cjs',
  'scripts/ci/__tests__/native-contract.test.cjs',
  ...Object.keys(TEST_GLOBS),
])
const NODE_ARGS = Object.freeze(['--experimental-transform-types', '--test'])
const TEST_CONCURRENCY = 1
const NATIVE_TEST_FILES = Object.freeze([
  'src/main/sandbox.test.ts',
  'src/preload/menu.test.ts',
  'src/preload/menureact.test.ts',
  'src/main/plugins.test.ts',
  'src/main/preferences.test.ts',
  'src/main/persistence.test.ts',
  'src/main/policy.test.ts',
  'src/main/inspector.test.ts',
  'src/main/binding.test.ts',
  'src/main/chromiumrelay.test.ts',
  'src/main/agentbrowser.test.ts',
  'src/main/searchdom.test.ts',
  'src/main/browser.test.ts',
  'native/storage.test.cjs',
  'scripts/cd/__tests__/updater.test.cjs',
  'native/shipit/fingerprint.test.cjs',
])

function walkTestFiles(directory, relative, recursive) {
  return fs
    .readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory())
        return recursive && entry.name !== 'node_modules'
          ? walkTestFiles(directory, child, recursive)
          : []
      return entry.isFile() && entry.name.endsWith('.test.ts')
        ? [child.split(path.sep).join('/')]
        : []
    })
}

function expandTestGlob(pattern, directory = DESKTOP) {
  if (!Object.hasOwn(TEST_GLOBS, pattern)) throw new Error(`unsupported test glob: ${pattern}`)
  const scope = TEST_GLOBS[pattern]
  return walkTestFiles(directory, scope.directory, scope.recursive).sort()
}

function testFiles(directory = DESKTOP) {
  return [
    ...new Set(
      TEST_FILES.flatMap((filename) => {
        if (!filename.includes('*')) return [filename]
        const matches = expandTestGlob(filename, directory)
        if (!matches.length) throw new Error(`no test files match glob: ${filename}`)
        return matches
      })
    ),
  ]
}

function unitTestFiles(directory = DESKTOP) {
  return testFiles(directory).filter((filename) => !NATIVE_TEST_FILES.includes(filename))
}

function invocation(coverage = false, forwarded = []) {
  const files = coverage ? unitTestFiles() : TEST_FILES
  const args = [...NODE_ARGS, `--test-concurrency=${TEST_CONCURRENCY}`, ...files, ...forwarded]
  return {
    executable: process.execPath,
    args: coverage
      ? [path.join(DESKTOP, 'node_modules/c8/bin/c8.js'), process.execPath, ...args]
      : args,
  }
}

function main(argv = process.argv.slice(2), { launch = spawnSync } = {}) {
  const coverage = argv[0] === '--coverage'
  const command = invocation(coverage, coverage ? argv.slice(1) : argv)
  const result = launch(command.executable, command.args, {
    cwd: DESKTOP,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  })
  if (result.error) throw result.error
  return childExitCode(result)
}

module.exports = {
  DESKTOP,
  TEST_FILES,
  TEST_GLOBS,
  NODE_ARGS,
  TEST_CONCURRENCY,
  NATIVE_TEST_FILES,
  expandTestGlob,
  testFiles,
  unitTestFiles,
  invocation,
  main,
}
if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[desktop:test] ${error.message}`)
    process.exitCode = 1
  }
}
