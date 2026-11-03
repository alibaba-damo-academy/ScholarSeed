import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureSourceBaseline, sourceBaseline } from './source.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-baseline-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'feature/source')
  git('remote', 'add', 'origin', 'https://user:secret@git.example.org/example/repository.git')
  writeFileSync(join(root, 'program.txt'), 'version one')
  git('add', 'program.txt')
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'initial'
  )
  return { root, git }
}

test('startup captures the program repo and dirty state independently of conversation folders', async () => {
  const { root, git } = fixture()
  try {
    const value = JSON.parse((await captureSourceBaseline(root, '0.3.0-202610261200', false))!)
    assert.equal(value.commit, git('rev-parse', 'HEAD'))
    assert.equal(value.branch, 'feature/source')
    assert.equal(value.repository_url, 'https://git.example.org/example/repository.git')
    assert.equal(value.dirty, false)
    assert.equal(value.status, 'captured')
    assert.equal(value.runtime_kind, 'local_dev')
    assert.ok(value.source_root)
    assert.ok(!sourceBaseline()!.includes('secret'))
    writeFileSync(join(root, 'program.txt'), 'edited')
    assert.equal(JSON.parse((await captureSourceBaseline(root, '0.3.0', false))!).dirty, true)
    git('checkout', '--', 'program.txt')
    writeFileSync(join(root, 'untracked.txt'), 'untracked')
    assert.equal(JSON.parse((await captureSourceBaseline(root, '0.3.0', false))!).dirty, true)
    assert.equal(await captureSourceBaseline(root, '0.3.0', true), undefined)
    assert.equal(sourceBaseline(), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unavailable source identity overwrites a prior launch instead of reusing it', async () => {
  const { root } = fixture()
  const empty = mkdtempSync(join(tmpdir(), 'source-unavailable-'))
  execFileSync('git', ['init', '-q', empty])
  try {
    await captureSourceBaseline(root, '0.3.0', false)
    const value = JSON.parse((await captureSourceBaseline(empty, '0.3.0', false))!)
    assert.equal(value.status, 'unavailable')
    assert.equal(value.commit, undefined)
    assert.equal(value.reason, 'source_identity_unavailable')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})
