import type { ComposerReference } from '../../store'
import type { DocumentSource } from '../workbench/api'

export type ImageAttachment = Extract<ComposerReference, { type: 'file' }>
export const ATTACHMENT_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

export function isImageAttachment(ref: ComposerReference): ref is ImageAttachment {
  if (ref.type !== 'file') return false
  const extension = (ref.title || ref.path).split('.').at(-1)?.toLowerCase() ?? ''
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_IMAGE_TYPES, extension)
}

export function partitionAttachments(refs: ComposerReference[]): {
  images: { ref: ImageAttachment; index: number }[]
  files: { ref: ComposerReference; index: number }[]
} {
  const images: { ref: ImageAttachment; index: number }[] = []
  const files: { ref: ComposerReference; index: number }[] = []
  refs.forEach((ref, index) => {
    if (isImageAttachment(ref)) images.push({ ref, index })
    else files.push({ ref, index })
  })
  return { images, files }
}

export function attachmentImageSource(ref: ImageAttachment, sessionId?: string): DocumentSource {
  if (ref.previewSource) return ref.previewSource
  return sessionId
    ? { kind: 'session-file', sessionId, path: ref.path, mediaType: ref.mediaType }
    : { kind: 'runtime-file', path: ref.path, mediaType: ref.mediaType }
}

export async function authorizeAttachmentOriginal(
  ref: ImageAttachment,
  sessionId: string | undefined,
  verify: (source: DocumentSource) => Promise<boolean>,
  grant: (path: string) => Promise<boolean>
): Promise<boolean> {
  const source = attachmentImageSource(ref, sessionId)
  if (source.kind !== 'session-file' || source.path !== ref.path) return false
  if (!(await verify(source))) return false
  return grant(source.path)
}
