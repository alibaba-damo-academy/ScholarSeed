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
import {
  attachmentImageSource,
  authorizeAttachmentOriginal,
  isImageAttachment,
  partitionAttachments,
} from './utils.ts'

test('native message wiring shares the gallery and releases resource URLs without granting file authority', () => {
  const renderer = readFileSync(new URL('./Images.tsx', import.meta.url), 'utf8')
  const attachments = readFileSync(new URL('./Attachments.tsx', import.meta.url), 'utf8')
  assert.match(renderer, /Images as ImageGroup/)
  assert.match(renderer, /if \(disposed\) return/)
  assert.match(renderer, /URL\.revokeObjectURL/)
  const sources = readFileSync(new URL('./pictures.ts', import.meta.url), 'utf8')
  assert.match(sources, /reference\.id,\s+reference\.path,\s+reference\.sha256/)
  assert.match(sources, /artifact\.status === 'failed'/)
  assert.match(renderer, /artifactImageAsset\(sessionId, artifact\)/)
  assert.match(renderer, /GeneratedImageGallery/)
  assert.match(renderer, /if \(\!eligibleImage\(artifact\)\) return null/)
  assert.match(attachments, /importAttachmentToResources/)
  assert.match(attachments, /<AttachmentImages/)
  assert.match(
    attachments,
    /refs=\{refs\}[\s\S]*sessionId=\{thread\.sessionId \?\? undefined\}[\s\S]*sent/
  )
  assert.match(attachments, /<AttachmentFiles[\s\S]*refs=\{files\.map\(\(row\) => row\.ref\)\}/)
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
  for (const suffix of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp']) {
    assert.equal(
      imageReference({
        type: 'file',
        id: suffix,
        title: `plot.${suffix}`,
        path: `/plot.${suffix}`,
      }),
      true
    )
  }
  for (const suffix of ['tif', 'tiff']) {
    assert.equal(
      imageReference({
        type: 'file',
        id: suffix,
        title: `plot.${suffix}`,
        path: `/plot.${suffix}`,
        mediaType: 'image/tiff',
      }),
      false
    )
  }
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
    if (!forbidden && String(url).endsWith('/artifacts/published-id/open'))
      return Response.json({
        viewer: 'image',
        processor: null,
        content_kind: 'binary',
        capabilities: {
          can_preview: true,
          can_edit: false,
          can_select: false,
          can_annotate: false,
          can_save: false,
          can_version: false,
          can_diff: false,
          pending: [],
        },
        media_type: 'image/png',
        size: 'image bytes'.length,
        revision: await sha256Text('image bytes'),
      })
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
    assert.deepEqual(calls.slice(-2), [
      {
        url: 'http://test/api/serve/sessions/session-one/artifacts/published-id/open',
        credentials: 'include',
      },
      {
        url: 'http://test/api/serve/sessions/session-one/artifacts/published-id/raw',
        credentials: 'include',
      },
    ])
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

test('only supported image formats form an ordered image group, without a count cap', () => {
  for (const extension of ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp'])
    assert.equal(
      isImageAttachment({
        type: 'file',
        id: extension,
        path: `C:\\images\\A.${extension.toUpperCase()}`,
        title: `A.${extension}`,
      }),
      true
    )
  for (const extension of ['tiff', 'eps', 'psd', 'heic'])
    assert.equal(
      isImageAttachment({
        type: 'file',
        id: extension,
        path: `a.${extension}`,
        title: `a.${extension}`,
        mediaType: 'image/unknown',
      }),
      false
    )
  const refs = Array.from({ length: 23 }, (_, index) => ({
    type: 'file' as const,
    id: String(index),
    title: `${index}.png`,
    path: `${index}.png`,
  }))
  const file = { type: 'file' as const, id: 'pdf', title: 'paper.pdf', path: 'paper.pdf' }
  const split = partitionAttachments([file, ...refs])
  assert.deepEqual(
    split.images.map((row) => row.index),
    refs.map((_, index) => index + 1)
  )
  assert.deepEqual(split.files, [{ ref: file, index: 0 }])
})

test('attachment preview preserves an explicit authorized source and otherwise uses the session boundary', () => {
  const ref = { type: 'file' as const, id: 'ref', title: 'photo.png', path: '/project/photo.png' }
  assert.deepEqual(attachmentImageSource(ref, 'session'), {
    kind: 'session-file',
    sessionId: 'session',
    path: ref.path,
    mediaType: undefined,
  })
  const previewSource = {
    kind: 'session-file' as const,
    sessionId: 'upload',
    path: 'attachments/photo.png',
  }
  assert.equal(attachmentImageSource({ ...ref, previewSource }, 'session'), previewSource)
  assert.deepEqual(attachmentImageSource(ref), {
    kind: 'runtime-file',
    path: ref.path,
    mediaType: undefined,
  })
})

test('external actions grant only the exact session file after a successful backend authorization read', async () => {
  const ref = { type: 'file' as const, id: 'photo', title: 'photo.png', path: '/outside/photo.png' }
  const grants: string[] = []
  const grant = async (path: string): Promise<boolean> => {
    grants.push(path)
    return true
  }
  assert.equal(await authorizeAttachmentOriginal(ref, 'session', async () => false, grant), false)
  assert.deepEqual(grants, [])
  assert.equal(await authorizeAttachmentOriginal(ref, 'session', async () => true, grant), true)
  assert.deepEqual(grants, [ref.path])
  assert.equal(
    await authorizeAttachmentOriginal(
      {
        ...ref,
        previewSource: { kind: 'session-file', sessionId: 'session', path: 'another.png' },
      },
      'session',
      async () => true,
      grant
    ),
    false
  )
  assert.deepEqual(grants, [ref.path])
  assert.equal(await authorizeAttachmentOriginal(ref, undefined, async () => true, grant), false)
})
