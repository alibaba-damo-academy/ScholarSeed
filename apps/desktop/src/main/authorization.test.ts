import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PathAuthorizer } from './authorization.ts'

function withFixture(run: (fixture: {
  root: string
  file: string
  sibling: string
  outsideFile: string
  escapeLink: string
}) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'scholarseed-path-authorization-'))
  try {
    const root = join(base, 'project')
    const sibling = join(base, 'project-copy')
    mkdirSync(root)
    mkdirSync(sibling)
    const file = join(root, 'result.md')
    const outsideFile = join(sibling, 'secret.md')
    const escapeLink = join(root, 'escape.md')
    writeFileSync(file, 'allowed')
    writeFileSync(outsideFile, 'denied')
    symlinkSync(outsideFile, escapeLink)
    run({ root, file, sibling, outsideFile, escapeLink })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

test('fails closed when no Service-authorized roots have been synchronized', () => {
  withFixture(({ file }) => {
    assert.equal(new PathAuthorizer().resolveAuthorized(file), null)
  })
})

test('allows canonical descendants but rejects a sibling with the same prefix', () => {
  withFixture(({ root, file, outsideFile }) => {
    const authorizer = new PathAuthorizer()
    authorizer.replace('workspace', [root])
    assert.equal(authorizer.resolveAuthorized(file), realpathSync.native(file))
    assert.equal(authorizer.resolveAuthorized(outsideFile), null)
  })
})

test('an authorized file permits only that exact file, not its parent or siblings', () => {
  withFixture(({ root, file, outsideFile }) => {
    const authorizer = new PathAuthorizer()
    authorizer.replace('external', [file])
    assert.equal(authorizer.resolveAuthorized(file), realpathSync.native(file))
    assert.equal(authorizer.resolveAuthorized(root), null)
    assert.equal(authorizer.resolveAuthorized(outsideFile), null)
  })
})

test('rejects a symlink inside an authorized root when its real target escapes', () => {
  withFixture(({ root, escapeLink }) => {
    const authorizer = new PathAuthorizer()
    authorizer.replace('workspace', [root])
    assert.equal(authorizer.resolveAuthorized(escapeLink), null)
  })
})

test('replacing a Service scope revokes roots missing from the new snapshot', () => {
  withFixture(({ root, file, sibling, outsideFile }) => {
    const authorizer = new PathAuthorizer()
    authorizer.replace('workspace', [root])
    authorizer.replace('workspace', [sibling])
    assert.equal(authorizer.resolveAuthorized(file), null)
    assert.equal(authorizer.resolveAuthorized(outsideFile), realpathSync.native(outsideFile))
  })
})
