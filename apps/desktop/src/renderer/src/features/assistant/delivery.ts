import type { SessionArtifact } from '../../model'
import { groupArtifactBlocks } from '../../components/business/partition.ts'
import { supportsImagePreview } from '../workbench/image.ts'

const PDF_MEDIA_TYPE = 'application/pdf'
const BINARY_MEDIA_TYPE = 'application/octet-stream'
const PDF_SUFFIX = '.pdf'

export function artifactPreviewKind(
  artifact: SessionArtifact & { kind?: string }
): 'image' | 'pdf' | null {
  if (
    artifact.kind === 'directory' ||
    artifact.status === 'failed' ||
    artifact.status === 'deleted' ||
    artifact.change === 'delete'
  )
    return null
  const mediaType = artifact.media_type?.split(';', 1)[0].trim().toLowerCase() ?? ''
  if (mediaType && mediaType !== BINARY_MEDIA_TYPE) {
    if (mediaType === PDF_MEDIA_TYPE) return 'pdf'
    return supportsImagePreview('', mediaType) ? 'image' : null
  }
  const path = artifact.name || artifact.path
  if (path.toLowerCase().endsWith(PDF_SUFFIX)) return 'pdf'
  return supportsImagePreview(path) ? 'image' : null
}

export function eligibleImage(artifact: SessionArtifact): boolean {
  return artifactPreviewKind(artifact) === 'image'
}

export function eligiblePdf(artifact: SessionArtifact): boolean {
  return artifactPreviewKind(artifact) === 'pdf'
}

export function groupArtifacts(entries: SessionArtifact[][]): {
  kind: 'images' | 'files'
  entries: SessionArtifact[][]
}[] {
  return groupArtifactBlocks(
    entries.filter((versions) => versions.length),
    (versions) => (eligibleImage(versions[0]) ? 'images' : 'files')
  )
}
