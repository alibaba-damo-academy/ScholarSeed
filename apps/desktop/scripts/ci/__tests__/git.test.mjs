import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGitBlobs } from '../git.mjs'

test('batch Git reads preserve exact revision, UTF-8 lengths, empty blobs and unusual filenames', () => {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-git-blobs-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const contents = new Map([
    ['space name.tsx', '原始文字\nsecond line\n'],
    [process.platform === 'win32' ? 'line break (2).tsx' : 'line\nbreak.tsx', 'another\nblob 123\n'],
    ['référence.tsx', 'référence 中文'],
    ['empty.tsx', ''],
  ])
  try {
    git('init', '-q')
    for (const [name, content] of contents) writeFileSync(join(root, name), content)
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(root, 'space name.tsx'), 'staged')
    git('add', 'space name.tsx')
    writeFileSync(join(root, 'space name.tsx'), 'unstaged')
    const specifications = [...contents.keys()].map((name) => `${base}:${name}`)
    const result = readGitBlobs([...specifications, ':space name.tsx'], { root })
    for (const [name, content] of contents) assert.equal(result.get(`${base}:${name}`), content)
    assert.equal(result.get(':space name.tsx'), 'staged')
    assert.throws(() => readGitBlobs([`${base}:missing.tsx`], { root }), /Git blob/)
    assert.deepEqual(readGitBlobs([], { root }), new Map())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
