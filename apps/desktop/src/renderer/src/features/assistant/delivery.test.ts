import assert from 'node:assert/strict'
import test from 'node:test'
import { artifactPreviewKind, eligibleImage, eligiblePdf, groupArtifacts } from './delivery.ts'

test('delivery consolidates each kind while preserving first-kind order and versions', () => {
  const item = (name: string, status?: 'failed') => [
    { artifact_id: name, name, path: name, status },
  ]
  const versions = [
    { artifact_id: 'revision-2', name: 'b.png', path: 'b.png' },
    { artifact_id: 'revision-1', name: 'b.png', path: 'b.png' },
  ]
  const first = item('a.png')
  const file = item('report.md')
  const pdf = item('report.pdf')
  const invalid = item('missing.png', 'failed')
  const last = item('c.jpg')
  assert.deepEqual(groupArtifacts([first, versions, file, pdf, invalid, last]), [
    { kind: 'images', entries: [first, versions, last] },
    { kind: 'files', entries: [file, pdf, invalid] },
  ])
  assert.deepEqual(groupArtifacts([[], file, first, invalid, last, versions]), [
    { kind: 'files', entries: [file, invalid] },
    { kind: 'images', entries: [first, last, versions] },
  ])
  assert.deepEqual(groupArtifacts([]), [])
})

test('PDF artifacts remain ordinary files and never join the image block', () => {
  const pdf = {
    artifact_id: 'pdf',
    name: 'document',
    path: 'document',
    media_type: 'application/pdf; charset=binary',
  }
  const png = { artifact_id: 'png', name: 'image.png', path: 'image.png' }
  const missing = { ...pdf, artifact_id: 'failed', status: 'failed' as const }
  assert.deepEqual(groupArtifacts([[pdf], [missing], [png]]), [
    { kind: 'files', entries: [[pdf], [missing]] },
    { kind: 'images', entries: [[png]] },
  ])
})

test('preview kinds are mutually exclusive and authoritative MIME precedes suffixes', () => {
  for (const [name, media_type, expected] of [
    ['plot.pdf', 'image/png', 'image'],
    ['report.png', 'application/pdf', 'pdf'],
    ['document.pdf', 'text/plain', null],
    ['image.png', 'application/json', null],
    ['report.PNG', ' APPLICATION/PDF ; charset=binary', 'pdf'],
    ['plot.PDF', ' IMAGE/PNG ; charset=binary', 'image'],
    ['report.PDF', 'application/octet-stream', 'pdf'],
    ['image.PNG', 'application/octet-stream', 'image'],
    ['report.PDF', '', 'pdf'],
    ['image.PNG', '', 'image'],
  ] as const) {
    const artifact = { artifact_id: name, name, path: name, media_type }
    assert.equal(artifactPreviewKind(artifact), expected)
    assert.equal(
      eligiblePdf(artifact) ? 'pdf' : eligibleImage(artifact) ? 'image' : null,
      expected,
      `${name}: ${media_type}`
    )
    assert.equal(eligibleImage(artifact), expected === 'image')
    assert.equal(eligiblePdf(artifact), expected === 'pdf')
    assert.equal(eligibleImage(artifact) && eligiblePdf(artifact), false)
    assert.equal(artifactPreviewKind({ ...artifact, kind: 'directory' }), null)
  }
})
