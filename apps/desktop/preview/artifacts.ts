import { createHash, randomUUID } from 'node:crypto'
import type { SessionArtifact } from '../src/renderer/src/model.ts'
import type { PreviewFileContent } from './files.ts'
import { PREVIEW_ARTIFACTS, type PreviewArtifactPolicy } from './publications.ts'
import { previewDocumentFormat } from './samples.ts'

type ReadKind = 'catalog' | 'history' | 'content'
type ArtifactRole = NonNullable<SessionArtifact['role']>
interface Publication {
  readonly session: string
  readonly file: PreviewFileContent
  readonly artifact: SessionArtifact
}
const REVISION_PREFIX = 'sha256:'
const ROLES: readonly ArtifactRole[] = ['final', 'intermediate', 'supporting']
const READ_POLICIES = { catalog: 'catalogRead', history: 'historyRead', content: 'contentRead' } as const

export class PreviewArtifactsError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'PreviewArtifactsError'
  }
}

export class PreviewArtifacts {
  private readonly policy: PreviewArtifactPolicy
  private readonly publications = new Map<string, Publication>()
  private readonly identities = new Map<string, string>()
  private readonly pending = new Set<() => void>()
  private disposed = false
  private recovered = false

  constructor(policy: PreviewArtifactPolicy) {
    this.policy = { ...policy }
  }

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.disposed, 410)
  }

  publish(sessionId: string, turnId: string, file: PreviewFileContent, role: ArtifactRole): SessionArtifact {
    this.active()
    if (!sessionId || !turnId || !file?.identity || file.kind !== 'file' || !ROLES.includes(role)) throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.invalid, 422)
    const key = JSON.stringify([sessionId, turnId, file.identity])
    const existing = this.identities.get(key)
    if (existing) return { ...this.publications.get(existing)!.artifact }
    if (!(file.bytes instanceof Uint8Array) || file.size !== file.bytes.byteLength) throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.invalid, 422)
    const digest = createHash('sha256').update(file.bytes).digest('hex')
    if (file.revision !== REVISION_PREFIX + digest) throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.invalid, 422)
    const captured = { ...file, bytes: file.bytes.slice() }
    const artifact: SessionArtifact = {
      artifact_id: randomUUID(), publication_id: randomUUID(),
      path: captured.path, name: captured.name, title: captured.name,
      media_type: previewDocumentFormat(captured.path, captured.bytes).mediaType,
      size: captured.size, sha256: digest, role, status: 'available', change: 'add',
      updated_at: captured.mtime, vendor_turn_id: turnId,
    }
    this.publications.set(artifact.artifact_id, { session: sessionId, file: captured, artifact })
    this.identities.set(key, artifact.artifact_id)
    return { ...artifact }
  }

  read(sessionId: string, artifactId: string): PreviewFileContent {
    this.active()
    const publication = this.publications.get(artifactId)
    if (!publication || publication.session !== sessionId) throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.notFound, 404)
    return { ...publication.file, bytes: publication.file.bytes.slice() }
  }

  async beforeRead(kind: ReadKind, signal?: AbortSignal): Promise<void> {
    this.active(signal)
    const mode = this.policy[READ_POLICIES[kind]]
    if (mode === 'failed' && !this.recovered) throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.readFailed, 503)
    if (mode === 'delayed') {
      await new Promise<void>((resolve, reject) => {
        const finish = (cancelled: boolean): void => {
          clearTimeout(timer)
          this.pending.delete(cancel)
          signal?.removeEventListener('abort', cancel)
          if (cancelled) reject(new PreviewArtifactsError(PREVIEW_ARTIFACTS.disposed, 410))
          else resolve()
        }
        const cancel = (): void => finish(true)
        const timer = setTimeout(() => finish(false), PREVIEW_ARTIFACTS.delayMs)
        this.pending.add(cancel)
        signal?.addEventListener('abort', cancel, { once: true })
      })
    }
    this.active(signal)
  }

  recover(): void {
    this.active()
    if (!Object.values(READ_POLICIES).some(key => this.policy[key] === 'failed')) throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.recoveryUnavailable, 409)
    this.recovered = true
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
    this.publications.clear()
    this.identities.clear()
  }
}
