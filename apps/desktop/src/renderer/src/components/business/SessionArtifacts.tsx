import React from 'react'
import { useTranslation } from 'react-i18next'

import { openByDefault } from '../../fileOpen'
import { Icon } from '../../icons'
import { SessionArtifact } from '../../model'
import { activeThread, useApp } from '../../store'
import { Button } from '../ui'

const TASK_BLOCK_CLASS_NAME = 'overflow-hidden rounded-none border-0 bg-transparent'
const TASK_BLOCK_HEAD_CLASS_NAME = 'flex w-full cursor-pointer items-center gap-[8px] border-0 bg-transparent px-[4px] pb-[9px] pt-[7px] text-left text-[inherit]'
const TASK_BLOCK_TITLE_CLASS_NAME = 'flex-none text-[12px] font-semibold text-[var(--text-2)]'
const TASK_BLOCK_COUNT_CLASS_NAME = 'flex-none text-[10.5px] font-semibold text-[var(--c-fact)]'
const TASK_BLOCK_CARET_CLASS_NAME = 'grid size-[18px] flex-none place-items-center text-[color-mix(in_srgb,var(--text-3)_58%,transparent)]'
const TASK_BLOCK_BODY_CLASS_NAME = 'border-t-0 pt-[var(--vds-space-1)]'
const TASK_BLOCK_EMPTY_CLASS_NAME = 'mb-[2px] mt-[6px] text-[11px] text-[var(--text-3)]'

function sizeLabel(size?: number): string {
  if (size == null) return ''
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`
  if (size >= 1_000) return `${(size / 1_000).toFixed(1)} KB`
  return `${size} B`
}

function artifactAbsolutePath(artifact: SessionArtifact, workdir?: string): string {
  if (artifact.absolute_path) return artifact.absolute_path
  return workdir ? `${workdir.replace(/\/$/, '')}/${artifact.path.replace(/^\//, '')}` : artifact.path
}

export function SessionArtifacts(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state, act } = useApp()
  const thread = activeThread(state)
  const [open, setOpen] = React.useState(false)
  const artifacts = (thread.artifacts ?? []).filter((artifact) => artifact.status !== 'deleted')

  React.useEffect(() => {
    setOpen(false)
  }, [thread.sessionId])

  const preview = (artifact: SessionArtifact): void => {
    const absolute = artifactAbsolutePath(artifact, thread.workdir)
    const sessionId = thread.sessionId || undefined
    void openByDefault(
      { relative: artifact.path, absolute, title: artifact.name },
      {
        openPreview: (target) => act.openFilePreview({
          ...target,
          absolutePath: absolute,
          sessionId,
          artifactId: artifact.artifact_id,
          mediaType: artifact.media_type,
          size: artifact.size
        }),
        onFailed: (_context, note) => act.openFilePreview({
          path: artifact.path,
          absolutePath: absolute,
          sessionId,
          artifactId: artifact.artifact_id,
          title: artifact.name,
          mediaType: artifact.media_type,
          size: artifact.size,
          content: note
        })
      }
    )
  }

  return (
    <div className={TASK_BLOCK_CLASS_NAME} data-testid="session-artifacts">
      <Button
        unstyled
        className={TASK_BLOCK_HEAD_CLASS_NAME}
        data-testid="session-artifacts-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={TASK_BLOCK_TITLE_CLASS_NAME}>{t('artifacts.title')}</span>
        {artifacts.length > 0 && <span className={TASK_BLOCK_COUNT_CLASS_NAME}>{artifacts.length}</span>}
        <span className="flex-1" />
        <span className={TASK_BLOCK_CARET_CLASS_NAME}>{open ? '▾' : '▸'}</span>
      </Button>
      {open && (
        <div className={TASK_BLOCK_BODY_CLASS_NAME} data-testid="session-artifacts-body">
          {artifacts.length === 0 ? (
            <p className={TASK_BLOCK_EMPTY_CLASS_NAME} data-testid="session-artifacts-empty">
              {t('artifacts.empty')}
            </p>
          ) : artifacts.map((artifact) => (
            <Button
              unstyled
              key={artifact.artifact_id}
              className="flex w-full cursor-pointer items-start gap-[8px] border-0 border-b border-[var(--border-soft)] bg-transparent px-[var(--vds-space-0)] py-[8px] text-left text-[var(--text-2)]"
              data-testid={`session-artifact-${artifact.artifact_id}`}
              onClick={() => preview(artifact)}
            >
              <Icon name="artifacts" size={13} />
              <span className="min-w-0 flex-1">
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-[var(--text)]">
                  {artifact.name}
                </span>
                <span className="mt-[2px] block overflow-hidden text-ellipsis whitespace-nowrap text-[9.5px] text-[var(--text-3)]">
                  {[t(artifact.role === 'final' ? 'artifacts.final' : artifact.role === 'intermediate' ? 'artifacts.intermediate' : 'artifacts.title'), artifact.change, sizeLabel(artifact.size)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </Button>
          ))}
          <Button
            unstyled
            className="mt-[8px] cursor-pointer border-0 bg-transparent p-[var(--vds-space-0)] text-[10.5px] text-[var(--text-3)] transition-[background,color,border-color] duration-[120ms] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]"
            data-testid="session-artifacts-open-workspace"
            onClick={() => act.openWorkspaceFiles(thread.sessionId || null)}
          >
            {t('artifacts.allFiles')}
          </Button>
        </div>
      )}
    </div>
  )
}
