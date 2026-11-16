const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')
const { resolveExample, readExampleFile, fileMetadata, EXAMPLE_ROOT } = require('../examples.cjs')

test('evaluation example contains the frozen source inputs needed by the adopted pages', () => {
  const plan = resolveExample({ projectId: 'evaluation' })
  const paths = new Set(plan.projects[0].files.map(file => file.path))
  for (const path of ['sample.md', 'sample.ts', 'overview.md', 'notes/detail.txt', 'notes/summary.md', 'notes/methods/appendix.md', 'sample.pdf', 'icon.png', 'sample.xlsx', 'sample.csv', 'sample.tsv', 'sample.bib']) assert.ok(paths.has(path), path)
  for (const file of plan.projects[0].files) assert.equal(readExampleFile(file).length, file.size)
})

function fixture(operation) {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-examples-'))
  try {
    cpSync(EXAMPLE_ROOT, root, { recursive: true })
    return operation(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function edit(root, path, operation) {
  const file = join(root, path)
  const value = JSON.parse(readFileSync(file, 'utf8'))
  operation(value)
  writeFileSync(file, JSON.stringify(value))
}

test('default and explicit selections use one manifest and return frozen portable identities', () => {
  const plan = resolveExample()
  assert.equal(plan.selection.kind, 'project')
  assert.equal(plan.projects.length, 1)
  assert.deepEqual(resolveExample({ projectId: plan.selection.id }), plan)
  assert.ok(Object.isFrozen(plan.projects[0].files))
  for (const file of plan.projects[0].files) {
    const bytes = readExampleFile(file)
    assert.equal(bytes.length, file.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
    assert.deepEqual(fileMetadata(file.sourcePath), { size: file.size, sha256: file.sha256 })
  }
})

test('same source under another root with spaces and Chinese keeps content identity', () => fixture(root => {
  const relocated = join(root, '另一目录 with spaces')
  mkdirSync(relocated)
  cpSync(EXAMPLE_ROOT, relocated, { recursive: true })
  const original = resolveExample()
  const moved = resolveExample({ root: relocated })
  assert.equal(moved.contentDigest, original.contentDigest)
  assert.notEqual(moved.projects[0].files[0].sourcePath, original.projects[0].files[0].sourcePath)
  assert.deepEqual(readExampleFile(moved.projects[0].files[0]), readExampleFile(original.projects[0].files[0]))
}))

test('empty workspace does not read unrelated projects and repeated templates have independent keys', () => fixture(root => {
  const project = resolveExample({ root }).selection.id
  writeFileSync(join(root, 'workspaces', 'empty.json'), JSON.stringify({ schemaVersion: 1, id: 'empty', revision: '1', projects: [] }))
  writeFileSync(join(root, 'workspaces', 'pair.json'), JSON.stringify({ schemaVersion: 1, id: 'pair', revision: '1', projects: [
    { key: 'first', projectId: project, projectRevision: '1' }, { key: 'second', projectId: project, projectRevision: '1' }
  ] }))
  const pair = resolveExample({ root, workspaceId: 'pair' })
  assert.deepEqual(pair.projects.map(item => item.key), ['first', 'second'])
  assert.notEqual(pair.projects[0], pair.projects[1])
  rmSync(join(root, 'projects'), { recursive: true })
  assert.deepEqual(resolveExample({ root, workspaceId: 'empty' }).projects, [])
}))

test('missing default, conflicting selections and unknown options are rejected', () => fixture(root => {
  assert.throws(() => resolveExample({ root, projectId: 'a', workspaceId: 'b' }), /selection/)
  assert.throws(() => resolveExample({ root, unsupported: true }), /unknown/)
  edit(root, 'manifest.json', value => { delete value.defaultProjectId })
  assert.throws(() => resolveExample({ root }), /defaultProjectId/)
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, defaultProjectId: 'missing' }))
  assert.throws(() => resolveExample({ root }), /ENOENT/)
  assert.equal(resolveExample({ root, projectId: 'research' }).selection.id, 'research')
}))

test('hash, size, revision and duplicate keys fail instead of selecting substitute data', () => fixture(root => {
  const projectId = resolveExample({ root }).selection.id
  const path = `projects/${projectId}/project.json`
  edit(root, path, value => { value.files[0].sha256 = '0'.repeat(64) })
  assert.throws(() => resolveExample({ root }), /integrity/)
  cpSync(EXAMPLE_ROOT, root, { recursive: true })
  edit(root, path, value => { value.files[0].size++ })
  assert.throws(() => resolveExample({ root }), /integrity/)
  cpSync(EXAMPLE_ROOT, root, { recursive: true })
  edit(root, 'workspaces/pair.json', value => { value.projects[0].projectRevision = 'obsolete' })
  assert.throws(() => resolveExample({ root, workspaceId: 'pair' }), /revision/)
  cpSync(EXAMPLE_ROOT, root, { recursive: true })
  edit(root, 'workspaces/pair.json', value => { value.projects[1].key = value.projects[0].key })
  assert.throws(() => resolveExample({ root, workspaceId: 'pair' }), /duplicate project key/)
}))

test('source mutation after resolution is rejected when bytes are consumed', () => fixture(root => {
  const file = resolveExample({ root }).projects[0].files[0]
  writeFileSync(file.sourcePath, 'changed')
  assert.throws(() => readExampleFile(file), /integrity/)
}))

test('unsafe targets, unknown fields and linked sources are rejected', () => {
  for (const target of ['../outside', '/absolute', 'C:/host', 'data\\host', 'CON.txt', 'trailing.']) fixture(root => {
    const projectId = resolveExample({ root }).selection.id
    edit(root, `projects/${projectId}/project.json`, value => { value.files[0].target = target })
    assert.throws(() => resolveExample({ root }), /path/)
  })
  fixture(root => {
    const projectId = resolveExample({ root }).selection.id
    edit(root, `projects/${projectId}/project.json`, value => { value.unsupported = true })
    assert.throws(() => resolveExample({ root }), /unknown/)
  })
  fixture(root => {
    const file = resolveExample({ root }).projects[0].files[0]
    rmSync(file.sourcePath)
    symlinkSync(resolve(__filename), file.sourcePath)
    assert.throws(() => resolveExample({ root }), /link/)
  })
})

test('a frozen identity rejects valid new bytes and accepts the exact restored source', () => fixture(root => {
  const original = resolveExample({ root })
  const file = original.projects[0].files[0]
  const bytes = readFileSync(file.sourcePath)
  const definitionPath = `projects/${original.selection.id}/project.json`
  writeFileSync(file.sourcePath, 'a different reviewed input\n')
  edit(root, definitionPath, value => {
    value.revision = '2'
    Object.assign(value.files[0], fileMetadata(file.sourcePath))
  })
  assert.notEqual(resolveExample({ root }).contentDigest, original.contentDigest)
  assert.throws(() => resolveExample({ root, expectedDigest: original.contentDigest }), /frozen input differs/)
  writeFileSync(file.sourcePath, bytes)
  edit(root, definitionPath, value => {
    value.revision = '1'
    Object.assign(value.files[0], fileMetadata(file.sourcePath))
  })
  assert.equal(resolveExample({ root, expectedDigest: original.contentDigest }).contentDigest, original.contentDigest)
}))

test('case, normalized Unicode and parent-child target collisions are rejected', () => {
  for (const targets of [['sample.md', 'SAMPLE.md'], ['café.md', 'cafe\u0301.md'], ['folder', 'folder/file.md']]) fixture(root => {
    const projectId = resolveExample({ root }).selection.id
    edit(root, `projects/${projectId}/project.json`, value => {
      value.files[0].target = targets[0]
      value.files[1].target = targets[1]
    })
    assert.throws(() => resolveExample({ root }), /conflicting targets/)
  })
})

test('shared assets reuse one source, and unknown revisions or files fail strictly', () => fixture(root => {
  const projectId = resolveExample({ root }).selection.id
  const projectPath = `projects/${projectId}/project.json`
  const source = resolveExample({ root }).projects[0].files[0]
  const assetRoot = join(root, 'assets', 'shared')
  mkdirSync(assetRoot, { recursive: true })
  writeFileSync(join(assetRoot, 'readme.md'), readFileSync(source.sourcePath))
  writeFileSync(join(assetRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'shared', revision: '1', source: { kind: 'synthetic', origin: 'test', rights: 'test input' },
    files: [{ id: 'overview', source: 'readme.md', mediaType: source.mediaType, size: source.size, sha256: source.sha256 }]
  }))
  edit(root, projectPath, value => {
    delete value.files[0].source
    Object.assign(value.files[0], { assetId: 'shared', assetRevision: '1', fileId: 'overview' })
  })
  const plan = resolveExample({ root })
  assert.equal(plan.projects[0].files[0].sourcePath, realpathSync(join(assetRoot, 'readme.md')))
  assert.deepEqual(readExampleFile(plan.projects[0].files[0]), readFileSync(source.sourcePath))
  edit(root, projectPath, value => { value.files[0].assetRevision = 'old' })
  assert.throws(() => resolveExample({ root }), /revision/)
  edit(root, projectPath, value => { value.files[0].assetRevision = '1'; value.files[0].fileId = 'missing' })
  assert.throws(() => resolveExample({ root }), /reference/)
  edit(root, projectPath, value => { value.files[0].fileId = 'overview'; value.files[0].source = 'files/readme.md' })
  assert.throws(() => resolveExample({ root }), /choose source or shared asset/)
}))

test('reordering provenance fields does not change content identity', () => fixture(root => {
  const plan = resolveExample({ root })
  edit(root, `projects/${plan.selection.id}/project.json`, value => {
    value.source = { rights: value.source.rights, origin: value.source.origin, kind: value.source.kind }
  })
  assert.equal(resolveExample({ root }).contentDigest, plan.contentDigest)
}))

test('source parent links and duplicate file identities are rejected', () => {
  fixture(root => {
    const plan = resolveExample({ root })
    const path = `projects/${plan.selection.id}/project.json`
    edit(root, path, value => { value.files[1].id = value.files[0].id })
    assert.throws(() => resolveExample({ root }), /duplicate file id/)
  })
  fixture(root => {
    const plan = resolveExample({ root })
    const files = join(root, 'projects', plan.selection.id, 'files')
    rmSync(files, { recursive: true })
    symlinkSync(resolve('examples/projects/research/files'), files, 'dir')
    assert.throws(() => resolveExample({ root }), /link/)
  })
})
