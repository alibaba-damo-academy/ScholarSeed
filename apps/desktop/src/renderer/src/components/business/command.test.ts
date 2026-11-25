import assert from 'node:assert/strict'
import test from 'node:test'

import { commandInputText, commandOutcome } from '../../command.ts'

test('command details display the top-level command verbatim for current and serialized inputs', () => {
  const command = '/bin/zsh -lc \'printf "one\\ntwo\\n"\''
  const input = { command, cwd: '/workspace', actions: [{ command: 'different command' }] }

  assert.equal(commandInputText(input), command)
  assert.equal(commandInputText(JSON.stringify(input)), command)
})

test('command details can retain the original input when there is no usable command field', () => {
  for (const input of [
    'printf test',
    '{"command":',
    '{"command":null}',
    { command: 123 },
    { command: '  ' },
    { actions: [{ command: 'printf test' }] },
  ]) {
    assert.equal(commandInputText(input), undefined)
  }
})

test('only an empty single search with exit code one is a neutral no-match', () => {
  assert.equal(
    commandOutcome({
      name: 'bash',
      status: 'error',
      input: { command: "rg -n 'absent' notes.md" },
      result: '',
      exitCode: 1,
    }),
    'noMatches'
  )
  assert.equal(
    commandOutcome({
      name: 'bash',
      status: 'error',
      input: { command: "grep -q 'absent' notes.md" },
      result: '',
      exitCode: 1,
    }),
    'noMatches'
  )
  assert.notEqual(
    commandOutcome({
      name: 'bash',
      status: 'error',
      input: { command: 'rg absent notes.md; echo done' },
      result: '',
      exitCode: 1,
    }),
    'noMatches'
  )
  assert.notEqual(
    commandOutcome({
      name: 'bash',
      status: 'error',
      input: { command: 'rg absent notes.md' },
      result: 'permission denied',
      exitCode: 1,
    }),
    'noMatches'
  )
  assert.notEqual(
    commandOutcome({
      name: 'bash',
      status: 'error',
      input: { command: 'rg absent notes.md' },
      result: '',
      exitCode: 2,
    }),
    'noMatches'
  )
  assert.equal(
    commandOutcome({
      name: 'read',
      status: 'error',
      input: {
        command: "/bin/zsh -lc 'rg -n absent notes.md'",
        actions: [{ type: 'search', command: 'rg -n absent notes.md' }],
      },
      result: '',
      exitCode: 1,
    }),
    'noMatches'
  )
  assert.notEqual(
    commandOutcome({
      name: 'read',
      status: 'error',
      input: {
        actions: [
          { type: 'search', command: 'rg -n absent notes.md' },
          { type: 'read', command: 'cat notes.md' },
        ],
      },
      result: '',
      exitCode: 1,
    }),
    'noMatches'
  )
})

test('real command failures retain a specific or honest generic reason', () => {
  assert.equal(
    commandOutcome({
      name: 'bash',
      status: 'error',
      result: 'text\nzsh:1: === not found',
      exitCode: 1,
    }),
    'commandNotFound'
  )
  assert.equal(
    commandOutcome({
      name: 'bash',
      status: 'error',
      result: 'bash: line 1: ./run: Permission denied',
      exitCode: 126,
    }),
    'permissionDenied'
  )
  assert.equal(
    commandOutcome({
      name: 'bash',
      status: 'error',
      result: 'rg: missing.txt: No such file or directory',
      exitCode: 2,
    }),
    'fileMissing'
  )
  assert.equal(
    commandOutcome({ name: 'bash', status: 'error', result: 'unexpected output', exitCode: 3 }),
    'nonzero'
  )
  assert.equal(
    commandOutcome({ name: 'bash', status: 'error', result: 'unexpected output' }),
    'unknown'
  )
  assert.equal(commandOutcome({ name: 'bash', status: 'done', exitCode: 0 }), 'none')
  assert.equal(commandOutcome({ name: 'read', status: 'error', exitCode: 1 }), 'nonzero')
})
