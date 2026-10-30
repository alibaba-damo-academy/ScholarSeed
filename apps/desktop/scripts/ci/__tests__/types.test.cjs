const assert = require('node:assert/strict')
const { mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir, constants } = require('node:os')
const { dirname, join, relative, resolve } = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const { projects: referencedProjects, run } = require('../types.cjs')

const DESKTOP = resolve(__dirname, '../../..')
const SOLUTION = resolve(DESKTOP, 'tsconfig.json')
const TYPESCRIPT_FILE = /\.(?:[cm]?ts|tsx)$/
const NODE_PREVIEW_ENTRIES = [
  'preview/plugin.ts',
  'preview/verify.ts',
  'preview/report.ts',
  'vite.preview.config.ts',
]

function projects() {
  const solution = ts.readConfigFile(SOLUTION, ts.sys.readFile)
  assert.equal(solution.error, undefined)
  return solution.config.references.map((reference) => {
    const filename = resolve(DESKTOP, reference.path)
    const config = ts.readConfigFile(filename, ts.sys.readFile)
    assert.equal(config.error, undefined)
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(filename),
      undefined,
      filename
    )
    assert.deepEqual(parsed.errors, [])
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    return {
      name: relative(DESKTOP, filename),
      options: parsed.options,
      roots: new Set(parsed.fileNames.map((file) => relative(DESKTOP, file).split('\\').join('/'))),
      files: new Set(
        program
          .getSourceFiles()
          .map((file) => relative(DESKTOP, file.fileName).split('\\').join('/'))
      ),
    }
  })
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(directory, entry.name)
    return entry.isDirectory()
      ? sources(filename)
      : TYPESCRIPT_FILE.test(entry.name)
        ? [filename]
        : []
  })
}

const CONFIGURED_PROJECTS = projects()

test('every Desktop TypeScript source, test and Playwright configuration has a project', () => {
  const configured = CONFIGURED_PROJECTS
  const files = [
    ...readdirSync(DESKTOP)
      .filter((filename) => TYPESCRIPT_FILE.test(filename))
      .map((filename) => resolve(DESKTOP, filename)),
    ...['src', 'preview', 'e2e'].flatMap((directory) => sources(resolve(DESKTOP, directory))),
  ]
  const missing = files
    .map((filename) => relative(DESKTOP, filename).split('\\').join('/'))
    .filter((filename) => !configured.some((project) => project.files.has(filename)))
  assert.deepEqual(missing, [])
})

test('previously uncovered integration tests belong to the explicit test project', () => {
  const configured = CONFIGURED_PROJECTS
  const testing = configured.find((project) => project.name === 'tsconfig.test.json')
  assert.ok(testing, 'a referenced test project is required')
  for (const filename of [
    'playwright.config.ts',
    'e2e/startup.spec.ts',
    'e2e/fixtures/installer.test.ts',
    'endpoints.test.ts',
  ]) {
    assert.ok(testing.roots.has(filename), filename)
  }
  assert.equal(
    testing.files.has('src/main/index.ts'),
    false,
    'unrelated main entry must retain its Node-only environment'
  )
})

test('preview host tools have an explicit mixed tools project while browser entries retain web ownership', () => {
  const configured = CONFIGURED_PROJECTS
  const tools = configured.find((project) => project.name === 'tsconfig.tools.json')
  const node = configured.find((project) => project.name === 'tsconfig.node.json')
  const web = configured.find((project) => project.name === 'tsconfig.web.json')
  for (const filename of NODE_PREVIEW_ENTRIES) {
    assert.ok(tools.roots.has(filename), filename)
    assert.equal(web.roots.has(filename), false, filename)
  }
  for (const filename of ['preview/entry.tsx', 'preview/host.tsx', 'preview/office.ts']) {
    assert.ok(web.roots.has(filename), filename)
    assert.equal(node.roots.has(filename), false, filename)
  }
})

test('project targets and strict checking contracts remain intact', () => {
  const configured = CONFIGURED_PROJECTS
  for (const project of configured) {
    assert.equal(project.options.composite, true, project.name)
    assert.equal(project.options.strict, true, project.name)
    assert.equal(project.options.noEmit, true, project.name)
    assert.equal(project.options.moduleResolution, ts.ModuleResolutionKind.Bundler, project.name)
  }
  assert.equal(
    configured.find((project) => project.name === 'tsconfig.node.json').options.target,
    ts.ScriptTarget.ES2022
  )
  assert.equal(
    configured.find((project) => project.name === 'tsconfig.web.json').options.target,
    ts.ScriptTarget.ES2020
  )
  assert.equal(
    configured.find((project) => project.name === 'tsconfig.tools.json').options.target,
    ts.ScriptTarget.ES2020
  )
  assert.equal(
    configured.find((project) => project.name === 'tsconfig.test.json').options.target,
    ts.ScriptTarget.ES2020
  )
})

test('type checks follow solution references in order and stop at the first failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-types-'))
  try {
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({ references: [{ path: './first.json' }, { path: './second.json' }] })
    )
    const expected = [resolve(directory, 'first.json'), resolve(directory, 'second.json')]
    assert.deepEqual(referencedProjects(directory), expected)
    const calls = []
    const execute = (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0 }
    }
    assert.equal(run({ desktop: directory, execute }), 0)
    assert.deepEqual(
      calls.map((call) => call.args),
      expected.map((project) => [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', project])
    )
    for (const call of calls) {
      assert.equal(call.command, process.execPath)
      assert.deepEqual(call.options, { cwd: directory, stdio: 'inherit', windowsHide: true })
    }
    calls.length = 0
    assert.equal(run({ desktop: directory, execute, args: ['--pretty', 'false'] }), 0)
    assert.deepEqual(calls[0].args.slice(4), [])
    assert.deepEqual(calls[1].args.slice(4), ['--pretty', 'false'])
    let count = 0
    assert.equal(
      run({
        desktop: directory,
        execute: () => {
          count += 1
          return { status: 7 }
        },
      }),
      7
    )
    assert.equal(count, 1)
    assert.throws(
      () => run({ desktop: directory, execute: () => ({ error: new Error('compiler missing') }) }),
      /compiler missing/
    )
    assert.equal(
      run({ desktop: directory, execute: () => ({ signal: 'SIGTERM' }) }),
      128 + constants.signals.SIGTERM
    )
    writeFileSync(join(directory, 'tsconfig.json'), '{}')
    assert.throws(() => referencedProjects(directory), /must reference/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('solution references accept TypeScript JSONC and preserve configuration diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-types-jsonc-'))
  const filename = join(directory, 'tsconfig.json')
  try {
    writeFileSync(
      filename,
      `{
      // TypeScript solution references may contain comments and trailing commas.
      "references": [
        { "path": "./first.json", },
        { "path": "./last.json", },
      ],
    }`
    )
    assert.deepEqual(referencedProjects(directory), [
      resolve(directory, 'first.json'),
      resolve(directory, 'last.json'),
    ])
    writeFileSync(filename, '{ "references": [')
    const invalid = ts.readConfigFile(filename, ts.sys.readFile).error
    assert.ok(invalid)
    assert.throws(
      () => referencedProjects(directory),
      (error) => {
        assert.ok(error.message.includes(filename))
        assert.ok(error.message.includes(`TS${invalid.code}`))
        assert.ok(
          error.message.includes(ts.flattenDiagnosticMessageText(invalid.messageText, '\n'))
        )
        return true
      }
    )
    rmSync(filename)
    const missing = ts.readConfigFile(filename, ts.sys.readFile).error
    assert.ok(missing)
    assert.throws(
      () => referencedProjects(directory),
      (error) => {
        assert.ok(error.message.includes(filename))
        assert.ok(error.message.includes(`TS${missing.code}`))
        return true
      }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
