import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  imageReference,
  isImageArtifact,
  loadImageAsset,
  sentImageAsset,
  artifactImageAsset,
} from './pictures.ts'
import type { SessionArtifact } from '../../model'
import { sha256Text } from './anchors.ts'

test('native message wiring shares the gallery and releases resource URLs without granting file authority', () => {
  const renderer = readFileSync(new URL('./Images.tsx', import.meta.url), 'utf8')
  const attachments = readFileSync(new URL('./Attachments.tsx', import.meta.url), 'utf8')
  assert.match(renderer, /Images as ImageGroup/)
  assert.match(renderer, /if \(disposed\) return/)
  assert.match(renderer, /URL\.revokeObjectURL/)
  const sources = readFileSync(new URL('./pictures.ts', import.meta.url), 'utf8')
  assert.match(sources, /reference\.id,\s+reference\.path,\s+reference\.sha256/)
  assert.match(sources, /artifact\.status === 'failed'/)
  assert.match(renderer, /artifacts.filter\(isImageArtifact\)/)
  assert.match(renderer, /artifactImageAsset\(sessionId, artifact\)/)
  assert.match(renderer, /ImageBatch.Provider/)
  assert.match(renderer, /thumbnails=\{false\}/)
  assert.match(renderer, /batch.select\(identity\)/)
  assert.match(attachments, /importAttachmentToResources/)
  assert.match(attachments, /<SentImages/)
  assert.match(attachments, /refs=\{files\}/)
})

test('image layout and gallery share format and lifecycle eligibility', () => {
  const artifact = {
    artifact_id: 'image',
    name: 'image.png',
    path: 'image.png',
    status: 'available',
  } as SessionArtifact
  assert.equal(isImageArtifact(artifact), true)
  assert.equal(isImageArtifact({ ...artifact, name: 'image.PNG' }), true)
  assert.equal(isImageArtifact({ ...artifact, name: 'unknown', media_type: 'image/jpeg' }), true)
  assert.equal(isImageArtifact({ ...artifact, status: 'failed' }), false)
  assert.equal(isImageArtifact({ ...artifact, status: 'deleted' }), false)
  assert.equal(isImageArtifact({ ...artifact, change: 'delete' }), false)
  assert.equal(isImageArtifact({ ...artifact, name: 'report.txt', path: 'report.txt' }), false)
  assert.equal(isImageArtifact({ ...artifact, name: 'photo.heic', path: 'photo.heic' }), false)
})

test('only browser-supported images enter the image group', () => {
  assert.equal(imageReference({ type: 'file', id: 'a', title: 'a.png', path: '/a.png' }), true)
  assert.equal(
    imageReference({
      type: 'file',
      id: 'a',
      title: 'a.heic',
      path: '/a.heic',
      mediaType: 'image/heic',
    }),
    false
  )
  assert.equal(
    imageReference({ type: 'directory', id: 'a', title: 'a.png', path: '/a.png' }),
    false
  )
})

test('sent images retain authenticated source and reject changed bytes or forbidden reads', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const calls: { url: string; credentials: string | undefined }[] = []
  let forbidden = false
  Object.assign(globalThis, { window: { scholarseed: { getApiBase: () => 'http://test' } } })
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), credentials: init?.credentials })
    return new Response(forbidden ? '' : 'image bytes', {
      status: forbidden ? 403 : 200,
      headers: { 'content-type': 'image/png' },
    })
  }
  try {
    const reference = {
      type: 'file' as const,
      id: 'immutable-input',
      title: 'a.png',
      path: '/original/a.png',
      sha256: (await sha256Text('image bytes')).slice('sha256:'.length),
    }
    const result = await loadImageAsset(sentImageAsset('session-one', reference))
    assert.equal(result.error, null)
    assert.equal(await result.blob?.text(), 'image bytes')
    assert.deepEqual(calls[0], {
      url: 'http://test/api/serve/sessions/session-one/files/raw?path=%2Foriginal%2Fa.png',
      credentials: 'include',
    })
    const artifact = await loadImageAsset(
      artifactImageAsset('session-one', {
        artifact_id: 'published-id',
        name: 'a.png',
        path: 'different/local/path.png',
        sha256: reference.sha256,
      })
    )
    assert.equal(artifact.error, null)
    assert.equal(
      calls.at(-1)?.url,
      'http://test/api/serve/sessions/session-one/artifacts/published-id/raw'
    )
    const staleArtifact = await loadImageAsset(
      artifactImageAsset('session-one', {
        artifact_id: 'published-id',
        name: 'a.png',
        path: 'a.png',
        sha256: 'stale',
      })
    )
    assert.equal(staleArtifact.blob, null)
    assert.equal(staleArtifact.error, 'session_artifact_integrity_mismatch')
    const changed = await loadImageAsset(
      sentImageAsset('session-one', { ...reference, sha256: 'other-revision' })
    )
    assert.equal(changed.blob, null)
    assert.equal(changed.error, 'session_attachment_changed')
    forbidden = true
    assert.equal((await loadImageAsset(sentImageAsset('session-one', reference))).blob, null)
  } finally {
    globalThis.fetch = previousFetch
    Object.assign(globalThis, { window: previousWindow })
  }
})
