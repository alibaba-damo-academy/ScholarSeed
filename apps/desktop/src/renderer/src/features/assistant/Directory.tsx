import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FolderOpen } from 'lucide-react'

import { openSystemPath } from '../../api'
import { FileFormatIcon } from '../../components/primitive/FileIcon'
import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  EllipsisText,
} from '../../components/ui'
import type { FilePreviewTarget, SessionArtifact } from '../../model'
import {
  fetchArtifactDirectory,
  resolveArtifactDirectorySource,
  type ArtifactDirectorySnapshot,
} from './api'

export function ArtifactDirectory({
  artifact,
  sessionId,
  onClose,
  onOpen,
}: {
  artifact: SessionArtifact
  sessionId: string
  onClose: () => void
  onOpen: (target: FilePreviewTarget) => void
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [snapshot, setSnapshot] = useState<ArtifactDirectorySnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [folder, setFolder] = useState('')
  const [sourceAvailable, setSourceAvailable] = useState(false)
  const [openingSource, setOpeningSource] = useState(false)
  const [sourceFailed, setSourceFailed] = useState(false)
  const currentFolder = useRef<HTMLSpanElement>(null)
  const folderChanged = useRef(false)
  const title = artifact.title || artifact.name
  const crumbs = folder ? folder.split('/') : []
  const prefix = folder ? folder + '/' : ''
  const entries = (snapshot?.entries ?? [])
    .filter(
      (entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/')
    )
    .sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory'))

  function navigate(path: string): void {
    folderChanged.current = true
    setFolder(path)
  }

  useEffect(() => {
    if (folderChanged.current) currentFolder.current?.focus()
    folderChanged.current = false
  }, [folder])

  useEffect(() => {
    let disposed = false
    setFolder('')
    setSourceAvailable(false)
    setSourceFailed(false)
    void resolveArtifactDirectorySource(sessionId, artifact).then(
      (source) => {
        if (!disposed) setSourceAvailable(Boolean(source))
      },
      () => {}
    )
    return () => {
      disposed = true
    }
  }, [sessionId, artifact])

  async function openSource(): Promise<void> {
    setOpeningSource(true)
    setSourceFailed(false)
    try {
      const source = await resolveArtifactDirectorySource(sessionId, artifact)
      if (!source) setSourceAvailable(false)
      if (!source || !(await openSystemPath(source)).ok) setSourceFailed(true)
    } catch {
      setSourceFailed(true)
    } finally {
      setOpeningSource(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(null)
    setFailed(false)
    void fetchArtifactDirectory(sessionId, artifact.artifact_id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSnapshot(result)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [sessionId, artifact.artifact_id, attempt])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogContent
          headerLayout="aligned"
          className="!flex min-h-0 max-h-[calc(100dvh-var(--vds-space-8))] flex-col overflow-hidden"
        >
          <DialogHeader>
            <DialogTitle className="min-w-0 break-words">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              {t('artifactEntry.directorySnapshot')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
            <Badge title={snapshot?.sha256}>{t('artifactEntry.directoryReadOnly')}</Badge>
            {sourceAvailable && (
              <Button
                size="sm"
                variant="ghost"
                disabled={openingSource}
                onClick={() => void openSource()}
              >
                <FolderOpen aria-hidden />
                {t(
                  window.scholarseed?.platform === 'darwin'
                    ? 'artifactEntry.directoryOpenSourceMac'
                    : 'artifactEntry.directoryOpenSource'
                )}
              </Button>
            )}
          </div>
          {sourceFailed && <p role="alert">{t('artifactEntry.revealFailed')}</p>}
          {snapshot && (
            <Breadcrumb className="min-w-0 border-b border-[var(--vds-divider-default)] pb-[var(--vds-space-2)]">
              <BreadcrumbList className="flex-wrap">
                {[title, ...crumbs].map((label, index) => {
                  const path = crumbs.slice(0, index).join('/')
                  return (
                    <BreadcrumbItem key={path} className="min-w-0">
                      {index > 0 && <BreadcrumbSeparator />}
                      {index === crumbs.length ? (
                        <BreadcrumbPage ref={currentFolder} tabIndex={-1} className="min-w-0">
                          <EllipsisText>{label}</EllipsisText>
                        </BreadcrumbPage>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-w-0"
                          onClick={() => navigate(path)}
                        >
                          <EllipsisText>{label}</EllipsisText>
                        </Button>
                      )}
                    </BreadcrumbItem>
                  )
                })}
              </BreadcrumbList>
            </Breadcrumb>
          )}
          <div
            className="min-h-0 overflow-y-auto overscroll-contain"
            data-testid="artifact-directory-entries"
          >
            {failed ? (
              <div role="alert">
                <p>{t('artifactEntry.readFailed')}</p>
                <Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
                  {t('artifactEntry.retry')}
                </Button>
              </div>
            ) : !snapshot ? (
              <p role="status">{t('artifactEntry.directoryLoading')}</p>
            ) : entries.length ? (
              <ul className="m-0 list-none p-0">
                {entries.map((entry) => {
                  const name = entry.path.slice(prefix.length)
                  return (
                    <li key={entry.path}>
                      <Button
                        variant="ghost"
                        className="w-full min-w-0 justify-start"
                        onClick={() => {
                          if (entry.kind === 'directory') {
                            navigate(entry.path)
                            return
                          }
                          onOpen({
                            sessionId,
                            artifactId: artifact.artifact_id,
                            memberPath: entry.path,
                            path: entry.path,
                            title: name,
                            revisionId: entry.sha256,
                            mediaType: entry.media_type,
                            size: entry.size,
                          })
                          onClose()
                        }}
                      >
                        <FileFormatIcon
                          name={name}
                          kind={entry.kind === 'directory' ? 'dir' : 'file'}
                        />
                        <EllipsisText className="flex-1 text-left">{name}</EllipsisText>
                        {entry.kind === 'directory' && (
                          <ChevronRight
                            aria-hidden
                            className="shrink-0 text-[var(--vds-text-tertiary)]"
                          />
                        )}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="px-[var(--vds-space-3)] py-[var(--vds-space-4)] text-[var(--vds-text-secondary)]">
                {t('artifactEntry.directoryEmpty')}
              </p>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
