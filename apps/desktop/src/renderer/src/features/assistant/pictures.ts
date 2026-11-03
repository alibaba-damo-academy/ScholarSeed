import type { ComposerReference } from '../../contracts/assistant'
import { isDocumentLoadFailure, loadDocument, type DocumentSource } from '../workbench/api.ts'
import type { SessionArtifact } from '../../model'
import { imageMediaType } from '../workbench/image.ts'
import { sha256Bytes } from './anchors.ts'

export type ImageReference = Extract<ComposerReference, { type: 'file' }>
export interface ImageAsset {
  id: string
  title: string
  source: DocumentSource
  sha256?: string
}

export function sentImageAsset(sessionId: string, reference: ImageReference): ImageAsset {
  return {
    id: JSON.stringify([sessionId, reference.id, reference.path, reference.sha256]),
    title: reference.title,
    source: reference.previewSource ?? {
      kind: 'session-file',
      sessionId,
      path: reference.path,
      mediaType: reference.mediaType,
    },
    sha256: reference.sha256,
  }
}

export function artifactImageAsset(sessionId: string, artifact: SessionArtifact): ImageAsset {
  return {
    id: JSON.stringify([sessionId, artifact.artifact_id, artifact.sha256]),
    title: artifact.name,
    source: {
      kind: 'session-artifact',
      sessionId,
      artifactId: artifact.artifact_id,
      path: artifact.path,
      mediaType: artifact.media_type,
    },
    sha256: artifact.sha256,
  }
}

export function loadImageAsset(
  asset: ImageAsset
): Promise<{ blob: Blob | null; error: string | null }> {
  return loadImageSource(asset.source, asset.title, asset.sha256)
}
const SUPPORTED_IMAGES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])
const HASH_PREFIX = 'sha256:'
const CHANGED = 'session_attachment_changed'
const UNAVAILABLE = 'session_attachment_not_found'
const ARTIFACT_CHANGED = 'session_artifact_integrity_mismatch'
const ARTIFACT_UNAVAILABLE = 'session_artifact_not_found'

export function imageReference(reference: ComposerReference): reference is ImageReference {
  return (
    reference.type === 'file' &&
    SUPPORTED_IMAGES.has(
      imageMediaType(reference.title || reference.path, reference.mediaType ?? '')
    )
  )
}

async function loadImageSource(
  source: DocumentSource,
  title: string,
  sha256?: string
): Promise<{ blob: Blob | null; error: string | null }> {
  const loaded = await loadDocument(source)
  if (isDocumentLoadFailure(loaded)) return { blob: null, error: loaded.code }
  if (!loaded.capabilities.can_preview || loaded.viewer !== 'image')
    return {
      blob: null,
      error: source.kind === 'session-artifact' ? ARTIFACT_UNAVAILABLE : UNAVAILABLE,
    }
  if (
    sha256 &&
    (await sha256Bytes(loaded.bytes)) !==
      (sha256.startsWith(HASH_PREFIX) ? sha256 : HASH_PREFIX + sha256)
  )
    return { blob: null, error: source.kind === 'session-artifact' ? ARTIFACT_CHANGED : CHANGED }
  return {
    blob: new Blob([new Uint8Array(loaded.bytes)], {
      type: imageMediaType(title, loaded.mediaType),
    }),
    error: null,
  }
}
