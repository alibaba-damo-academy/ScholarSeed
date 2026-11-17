const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { sourceInputs } = require('../build.cjs')
const { version: packageVersion } = require('../../../package.json')

function fixture(context, branch) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-source-')))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'repo'), configuration = path.join(root, 'gitconfig')
  fs.mkdirSync(directory)
  fs.writeFileSync(configuration, '')
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: configuration, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()
  git('init', '-q', '-b', branch)
  fs.writeFileSync(path.join(directory, 'source.txt'), 'source\n')
  git('add', 'source.txt')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'source fixture')
  return { directory, git, commit: git('rev-parse', 'HEAD') }
}

test('distribution source rejects another version branch, including unsigned candidates', context => {
  for (const type of ['preview', 'release']) {
    const { directory } = fixture(context, `${type}/0.4.0`)
    for (const candidate of [false, true]) {
      assert.throws(() => sourceInputs({ type, candidate, version: '0.3.2' }, directory, {}),
        /source branch.*0\.4\.0.*build version.*0\.3\.2/i)
    }
  }
})

test('matching version branches and ordinary task branches remain eligible', context => {
  for (const branch of ['preview/0.3.2', 'release/0.3.2', 'feature/recovery']) {
    const { directory } = fixture(context, branch)
    for (const type of ['preview', 'release']) {
      const source = sourceInputs({ type, version: '0.3.2' }, directory, {})
      assert.equal(source.branch, branch)
      assert.equal(source.clean, true)
    }
  }
})

test('source version uses the same CLI, environment and package precedence as build options', context => {
  const { directory } = fixture(context, 'preview/0.4.0')
  const environment = { SCHOLARSEED_DESKTOP_VERSION: '0.3.2' }
  assert.equal(sourceInputs({ type: 'preview', version: '0.4.0' }, directory, environment).clean, true)
  assert.equal(sourceInputs({ type: 'preview' }, directory, { SCHOLARSEED_DESKTOP_VERSION: '0.4.0' }).clean, true)
  assert.throws(() => sourceInputs({ type: 'preview' }, directory, environment), /source branch.*build version/i)
  const declared = fixture(context, `preview/${packageVersion}`)
  assert.equal(sourceInputs({ type: 'preview' }, declared.directory, {}).clean, true)
})

test('detached CI version ref is checked only with its matching source commit', context => {
  const { directory, git, commit } = fixture(context, 'preview/0.4.0')
  git('checkout', '-q', '--detach')
  const environment = { CI_COMMIT_REF_NAME: 'preview/0.4.0', CI_COMMIT_SHA: commit }
  assert.throws(() => sourceInputs({ type: 'preview', version: '0.3.2' }, directory, environment),
    /source branch.*0\.4\.0.*build version.*0\.3\.2/i)
  assert.equal(sourceInputs({ type: 'preview', version: '0.4.0' }, directory, environment).clean, true)
  assert.throws(() => sourceInputs({ type: 'preview', version: '0.4.0' }, directory,
    { ...environment, CI_COMMIT_SHA: '0'.repeat(40) }), /CI source ref.*commit/i)
  assert.throws(() => sourceInputs({ type: 'preview', version: '0.4.0' }, directory,
    { CI_COMMIT_REF_NAME: 'preview/0.4.0' }), /CI source ref.*commit/i)
})

test('CI hints cannot override the checked-out branch and local dev keeps its dirty source contract', context => {
  const { directory, commit } = fixture(context, 'preview/0.4.0')
  const environment = { CI_COMMIT_REF_NAME: 'preview/0.3.2', CI_COMMIT_SHA: commit }
  assert.throws(() => sourceInputs({ type: 'preview', version: '0.3.2' }, directory, environment),
    /source branch.*0\.4\.0.*build version.*0\.3\.2/i)
  fs.writeFileSync(path.join(directory, 'source.txt'), 'changed\n')
  assert.equal(sourceInputs({ type: 'dev', version: '0.3.2' }, directory, environment).clean, false)
  assert.throws(() => sourceInputs({ type: 'preview', version: '0.4.0' }, directory, {}), /clean worktree/)
})

test('detached local version refs cannot bypass release version checks', context => {
  const { directory, git } = fixture(context, 'preview/0.4.0')
  git('checkout', '-q', '--detach')
  assert.throws(() => sourceInputs({ type: 'preview', version: '0.3.2' }, directory, {}),
    /source branch.*0\.4\.0.*build version.*0\.3\.2/i)
  assert.equal(sourceInputs({ type: 'preview', version: '0.4.0' }, directory, {}).clean, true)
  git('branch', '-m', 'preview/0.4.0', 'feature/recovery')
  git('update-ref', 'refs/remotes/origin/preview/0.4.0', 'HEAD')
  assert.throws(() => sourceInputs({ type: 'release', version: '0.3.2' }, directory, {}),
    /source branch.*0\.4\.0.*build version.*0\.3\.2/i)
})

test('conflicting detached version refs need an explicit checked-out or commit-bound CI branch', context => {
  const { directory, git, commit } = fixture(context, 'preview/0.4.0')
  git('branch', 'release/0.3.2')
  git('checkout', '-q', '--detach')
  assert.throws(() => sourceInputs({ type: 'preview', version: '0.3.2' }, directory, {}),
    /conflicting version branches/i)
  const environment = { CI_COMMIT_REF_NAME: 'release/0.3.2', CI_COMMIT_SHA: commit }
  assert.equal(sourceInputs({ type: 'release', version: '0.3.2' }, directory, environment).clean, true)
})
