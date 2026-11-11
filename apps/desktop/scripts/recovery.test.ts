import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRecoveryArguments, runRecoveryCommand, recoveryProbeArguments } from './recovery.ts'
import { TerminalRestorationError } from '../src/main/restoration.ts'
import { RecoveryInspectionError } from '../src/main/terminal.ts'

const INSPECTION_SCOPE = [
  '--application',
  '/Application.app',
  '--coordinator',
  '/coordinator',
  '--handoff',
  '/home/updates/squirrel.json',
  '--native-state',
  '/native/state',
  '--preparation',
  '/native/preparation',
  '--cleanup',
  '/native/cleanup',
  '--tool-directory',
  '/private/tool',
  '--expected-team',
  'KYG3VP6NVH',
]

test('recovery defaults to inspection and rejects mutation or incomplete scope', () => {
  assert.throws(() => parseRecoveryArguments(['apply']), /invalid_arguments/)
  assert.throws(() => parseRecoveryArguments(['inspect', '--apply']), /invalid_arguments/)
  assert.throws(
    () => parseRecoveryArguments(['inspect', '--application', '/Application.app']),
    /invalid_arguments/
  )
  assert.throws(
    () => parseRecoveryArguments(['build', '--output', '/one', '--output', '/two']),
    /invalid_arguments/
  )
})

test('help is available without reading records, compiling or inspecting', async () => {
  const output: unknown[] = []
  const code = await runRecoveryCommand(['--help'], {
    write: (value) => output.push(value),
    build: () => {
      throw new Error('must not compile')
    },
    inspect: async () => {
      throw new Error('must not inspect')
    },
  })
  assert.equal(code, 0)
  assert.match(String(output[0]), /inspect/)
  assert.match(String(output[0]), /No state is consumed/)
  assert.match(String(output[0]), /Orphan recovery.*signed App/)
})

test('CLI probe arguments require a complete typed terminal request before spawning', () => {
  const scope = parseRecoveryArguments(['inspect', ...INSPECTION_SCOPE])
  assert.equal(scope.mode, 'inspect')
  if (scope.mode !== 'inspect') throw new Error('Missing inspection scope')
  const request = {
    source: '/candidate/Source.app',
    binding: {
      schema: 1,
      requestId: 'a'.repeat(64),
      sha512: 'b'.repeat(128),
      size: 1,
      candidate: 'candidate',
    },
    selection: {
      schema: 2,
      paths: ['/home', '/profile', '/workspace'],
      identities: ['one', 'two', 'three'],
    },
  }
  const arguments_ = recoveryProbeArguments(scope.options, request)
  assert.equal(arguments_[arguments_.indexOf('--source') + 1], request.source)
  assert.ok(arguments_.every((value) => typeof value === 'string'))
  for (const changes of [
    { source: undefined },
    { binding: undefined },
    { selection: undefined },
    { source: '/candidate/../Source.app' },
    { selection: { ...request.selection, schema: true } },
  ]) {
    assert.throws(
      () => recoveryProbeArguments(scope.options, { ...request, ...changes }),
      (error) => error instanceof RecoveryInspectionError && error.code === 'invalid_records'
    )
  }
})

test('explicit build is independent of product inspection', async () => {
  const output: unknown[] = []
  let built = ''
  const code = await runRecoveryCommand(['build', '--output', '/private/tool'], {
    write: (value) => output.push(value),
    build: (directory) => {
      built = directory
      return { executable: '/private/tool/probe' }
    },
    inspect: async () => {
      throw new Error('must not inspect')
    },
  })
  assert.equal(code, 0)
  assert.equal(built, '/private/tool')
  assert.equal((output[0] as { mode: string }).mode, 'build')
})

test('invalid arguments and unexpected failures never echo private exception text', async () => {
  const output: unknown[] = []
  const code = await runRecoveryCommand(['build', '--output', '/private/tool'], {
    write: (value) => output.push(value),
    build: () => {
      throw new Error('private-native-failure')
    },
    inspect: async () => {
      throw new Error('must not inspect')
    },
  })
  assert.equal(code, 1)
  assert.ok(!JSON.stringify(output).includes('private-native-failure'))
})

test('apply requires the complete explicit scope and exact request ID with no force option', () => {
  assert.throws(() => parseRecoveryArguments(['apply', ...INSPECTION_SCOPE]), /invalid_arguments/)
  assert.throws(
    () => parseRecoveryArguments(['inspect', ...INSPECTION_SCOPE, '--request-id', 'a'.repeat(64)]),
    /invalid_arguments/
  )
  assert.throws(
    () =>
      parseRecoveryArguments([
        'apply',
        ...INSPECTION_SCOPE,
        '--request-id',
        'a'.repeat(64),
        '--force',
        'true',
      ]),
    /invalid_arguments/
  )
  const command = parseRecoveryArguments([
    'apply',
    ...INSPECTION_SCOPE,
    '--request-id',
    'a'.repeat(64),
  ])
  assert.equal(command.mode, 'apply')
})

test('maintenance compilation requires explicit local inputs and is awaited', async () => {
  assert.throws(
    () => parseRecoveryArguments(['build-maintenance', '--output', '/private/tool']),
    /invalid_arguments/
  )
  const output: unknown[] = []
  const result = await runRecoveryCommand(
    [
      'build-maintenance',
      '--output',
      '/private/tool',
      '--headers',
      '/local/headers.tar.gz',
      '--license',
      '/local/LICENSE',
    ],
    {
      write: (value) => output.push(value),
      build: () => {
        throw new Error('wrong builder')
      },
      inspect: async () => {
        throw new Error('must not inspect')
      },
      buildMaintenance: async (directory, inputs) => {
        assert.equal(directory, '/private/tool')
        assert.equal(inputs.headers, '/local/headers.tar.gz')
        return { lease: '/private/tool/native/lease.node' }
      },
    }
  )
  assert.equal(result, 0)
  assert.equal(
    (output[0] as { tool: { lease: string } }).tool.lease,
    '/private/tool/native/lease.node'
  )
})

test('partial or committed restoration failures do not falsely report zero mutation', async () => {
  for (const committed of [false, true]) {
    const output: unknown[] = []
    const result = await runRecoveryCommand(
      ['apply', ...INSPECTION_SCOPE, '--request-id', 'a'.repeat(64)],
      {
        write: (value) => output.push(value),
        build: () => {
          throw new Error('must not build')
        },
        inspect: async () => {
          throw new Error('must not inspect')
        },
        apply: async () => {
          throw new TerminalRestorationError('release_uncertain', true, committed)
        },
      }
    )
    assert.equal(result, 1)
    assert.equal((output[0] as { mutationPerformed: boolean }).mutationPerformed, true)
    assert.equal((output[0] as { committed: boolean }).committed, committed)
    assert.equal((output[0] as { executionAuthority: boolean }).executionAuthority, false)
  }
})
